const tus = require('@tus/server');
const TusServer = tus.Server;
const EVENTS = tus.EVENTS;
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs').promises;

// 유틸리티 함수 가져오기
const { log, errorLog, sanitizeFilename, updateDiskUsage } = require('./tus-utils');

// --- Configuration ---
const tusStorageDir = path.join(__dirname, 'tus-storage'); // Directory for temporary TUS uploads
const finalStorageDir = path.join(__dirname, 'share-folder'); // Final destination
const tusApiPath = '/api/tus/upload/'; // TUS endpoint path (슬래시로 끝나는 형식)

// Ensure TUS storage directory exists
async function ensureTusStorageDir() {
    try {
        await fs.mkdir(tusStorageDir, { recursive: true });
        log(`TUS storage directory ensured: ${tusStorageDir}`, 'info');
    } catch (error) {
        errorLog('Failed to create TUS storage directory', error);
        throw error; // Rethrow for now
    }
}

// Use the TusServer variable obtained above
const tusServer = new TusServer({
    path: tusApiPath,
    datastore: new FileStore({
        directory: tusStorageDir,
    }),
    // Add namingFunction to try and get metadata early (optional but helpful for logging/debugging)
    namingFunction: (req) => {
        return Date.now().toString(); // Placeholder ID generation
    },
    // It's good practice to define respectful termination handling
    respectForwardedHeaders: true // If behind a proxy like Nginx
});

// --- Event Listener for Upload Completion ---
tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, async (event) => {
    const file = event.file;
    log(`[TUS Complete] Upload completed for file ID: ${file.id}`, 'info');
    log(`[TUS Complete] File details: ${JSON.stringify(file)}`, 'debug');

    // 1. Extract Metadata
    const metadata = file.metadata;
    if (!metadata || !metadata.filename || !metadata.relativePath || !metadata.targetPath) {
        errorLog('[TUS Complete] Error: Missing required metadata (filename, relativePath, targetPath) for file ID: ' + file.id, null);
        // TODO: Handle missing metadata - delete the temp file?
        try {
            await fs.unlink(path.join(tusStorageDir, file.id));
            log(`[TUS Complete] Deleted temp file ${file.id} due to missing metadata.`, 'warn');
        } catch (unlinkError) {
            errorLog(`[TUS Complete] Error deleting temp file ${file.id} after missing metadata error`, unlinkError);
        }
        return;
    }

    let decodedRelativePath;
    try {
        // Frontend sends URI encoded relativePath
        decodedRelativePath = decodeURIComponent(metadata.relativePath);
    } catch (e) {
        errorLog(`[TUS Complete] Error: Failed to decode relativePath '${metadata.relativePath}' for file ID: ${file.id}`, e);
        // TODO: Handle decoding error - delete temp file?
        try {
            await fs.unlink(path.join(tusStorageDir, file.id));
             log(`[TUS Complete] Deleted temp file ${file.id} due to decode error.`, 'warn');
        } catch (unlinkError) {
            errorLog(`[TUS Complete] Error deleting temp file ${file.id} after decode error`, unlinkError);
        }
        return;
    }

    const targetPathBase = metadata.targetPath || ''; // Base path from client
    const originalFilename = metadata.filename; // Use filename from metadata

    log(`[TUS Complete] Metadata - Filename: ${originalFilename}, Decoded RelativePath: ${decodedRelativePath}, TargetPath: ${targetPathBase}`, 'debug');

    // 2. Determine Final Path
    // Combine targetPath (base) and decodedRelativePath
    const finalRelativePath = path.normalize(path.join(targetPathBase, decodedRelativePath));
    const finalDestinationPath = path.join(finalStorageDir, finalRelativePath);
    const finalDestinationDir = path.dirname(finalDestinationPath);

    // Use imported sanitizeFilename
    const finalFilename = sanitizeFilename(path.basename(finalDestinationPath));
    // Reconstruct final path with sanitized filename
    const finalSanitizedRelativePath = path.join(path.dirname(finalRelativePath), finalFilename);
    const finalDestinationPathSanitized = path.join(finalStorageDir, finalSanitizedRelativePath);
    const finalDestinationDirSanitized = path.dirname(finalDestinationPathSanitized);

    log(`[TUS Complete] Sanitized Filename: ${finalFilename}`, 'debug');
    log(`[TUS Complete] Final Sanitized Path - Directory: ${finalDestinationDirSanitized}`, 'info');
    log(`[TUS Complete] Final Sanitized Path - Full: ${finalDestinationPathSanitized}`, 'info');

    // 3. Ensure Destination Directory Exists (use sanitized path)
    try {
        await fs.mkdir(finalDestinationDirSanitized, { recursive: true, mode: 0o777 });
        log(`[TUS Complete] Ensured destination directory exists: ${finalDestinationDirSanitized}`, 'debug');
    } catch (mkdirError) {
        errorLog(`[TUS Complete] Error creating destination directory ${finalDestinationDirSanitized} for file ID: ${file.id}`, mkdirError);
        // TODO: Handle directory creation error - delete temp file?
         try {
            await fs.unlink(path.join(tusStorageDir, file.id));
             log(`[TUS Complete] Deleted temp file ${file.id} due to mkdir error.`, 'warn');
        } catch (unlinkError) {
            errorLog(`[TUS Complete] Error deleting temp file ${file.id} after mkdir error`, unlinkError);
        }
        return;
    }

    // 4. Move File from TUS Storage to Final Destination (use sanitized path)
    const sourcePath = path.join(tusStorageDir, file.id); // Path in tus-storage
    try {
        // Check if destination file already exists (use sanitized path)
        try {
            await fs.access(finalDestinationPathSanitized);
            // File exists - handle conflict (e.g., add suffix, error out)
            errorLog(`[TUS Complete] Error: File already exists at destination ${finalDestinationPathSanitized} for file ID: ${file.id}`, null);
            // For now, we will not move the file to prevent overwrite.
            // TODO: Implement conflict resolution logic if needed.
            throw new Error('File already exists at destination');
        } catch (accessError) {
            if (accessError.code !== 'ENOENT') {
                // Unexpected error checking destination
                throw accessError;
            }
            // ENOENT means file does not exist, proceed with move
        }

        await fs.rename(sourcePath, finalDestinationPathSanitized);
        log(`[TUS Complete] File moved successfully: ${sourcePath} -> ${finalDestinationPathSanitized}`, 'info');

        // Trigger disk usage update
        updateDiskUsage().catch(err => {
            errorLog('[TUS Complete] Failed to trigger disk usage update after file move', err);
        });

    } catch (moveError) {
        errorLog(`[TUS Complete] Error moving file ${file.id} from ${sourcePath} to ${finalDestinationPathSanitized}`, moveError);
        // If move fails, the file remains in tus-storage. Consider cleanup or retry logic.
    }
});

// --- Export Function to Mount TUS Server --- 
// This makes it easy to integrate into server.js
function mountTusServer(app) {
    // Ensure the storage directory exists before mounting
    ensureTusStorageDir().then(() => {
        app.all(`${tusApiPath}*`, tusServer.handle.bind(tusServer));
        log(`TUS server mounted at ${tusApiPath}`, 'info');
    }).catch(error => {
        errorLog('Failed to initialize TUS server, not mounting.', error);
    });
}

module.exports = { mountTusServer }; 
async function processTusFile(file) {
    try {
        tusLog(`Upload completed for file ID: ${file.id}`, 'info');
        
        // 1. 메타데이터 추출 및 검증
        const metadata = file.metadata || {};
        tusLog(`File metadata: ${JSON.stringify(metadata)}`, 'debug');
        
        if (!metadata.filename) {
            tusErrorLog(`Missing filename in metadata for file ID: ${file.id}`, null);
            return false;
        }
        
        // 기본 경로 설정
        const targetPathBase = metadata.targetPath || '';
        const originalFilename = metadata.filename;
        
        // RelativePath 처리 (디코딩)
        let decodedRelativePath;
        try {
            decodedRelativePath = metadata.relativePath ? 
                decodeURIComponent(metadata.relativePath) : originalFilename;
        } catch (e) {
            tusErrorLog(`Failed to decode relativePath for file ID: ${file.id}`, e);
            return false;
        }

        tusLog(`Processing file: ${originalFilename}, Path: ${targetPathBase}, RelativePath: ${decodedRelativePath}`, 'info');

        // 2. 최종 경로 계산
        const sanitizedFilename = utilFunctions.sanitizeFilename(path.basename(decodedRelativePath));
        const dirPath = path.dirname(decodedRelativePath) === '.' ? '' : path.dirname(decodedRelativePath);
        
        const finalDirPath = path.join(finalStorageDir, targetPathBase, dirPath);
        const finalFilePath = path.join(finalDirPath, sanitizedFilename);
        
        tusLog(`Final directory: ${finalDirPath}`, 'info');
        tusLog(`Final file path: ${finalFilePath}`, 'info');

        // 임시 파일 경로 확인
        const sourcePath = path.join(tusStorageDir, file.id);
        if (!fsSync.existsSync(sourcePath)) {
            tusErrorLog(`Source file not found: ${sourcePath}`, null);
            return false;
        } else {
            tusLog(`Source file exists: ${sourcePath}`, 'debug');
            // 파일 크기 로깅
            const stats = fsSync.statSync(sourcePath);
            tusLog(`Source file size: ${stats.size} bytes`, 'debug');
        }

        // 3. 대상 디렉토리 생성
        try {
            if (!fsSync.existsSync(finalDirPath)) {
                await fs.mkdir(finalDirPath, { recursive: true, mode: 0o777 });
                tusLog(`Created destination directory: ${finalDirPath}`, 'info');
            }
        } catch (mkdirError) {
            tusErrorLog(`Error creating directory ${finalDirPath}`, mkdirError);
            return false;
        }

        // 4. 파일 이동
        try {
            // 파일 존재 여부 확인
            const fileAlreadyExists = fsSync.existsSync(finalFilePath);
            
            if (fileAlreadyExists) {
                // 충돌 처리: 타임스탬프 추가
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const fileExt = path.extname(finalFilePath);
                const fileBase = path.basename(finalFilePath, fileExt);
                const newFilePath = path.join(
                    path.dirname(finalFilePath),
                    `${fileBase}_${timestamp}${fileExt}`
                );
                
                tusLog(`File already exists, saving as: ${newFilePath}`, 'warn');
                await fs.rename(sourcePath, newFilePath);
                tusLog(`File moved with new name: ${newFilePath}`, 'info');
            } else {
                // 그대로 이동
                await fs.rename(sourcePath, finalFilePath);
                tusLog(`File moved successfully: ${finalFilePath}`, 'info');
            }
            
            // 메타데이터 파일 삭제
            const metaFile = path.join(tusStorageDir, `${file.id}.json`);
            if (fsSync.existsSync(metaFile)) {
                await fs.unlink(metaFile);
                tusLog(`Metadata file deleted: ${metaFile}`, 'debug');
            }
            
            // 디스크 사용량 업데이트
            if (typeof utilFunctions.updateDiskUsage === 'function') {
                try {
                    await utilFunctions.updateDiskUsage();
                    tusLog('Disk usage updated', 'debug');
                } catch (e) {
                    tusErrorLog('Failed to update disk usage', e);
                }
            }
            
            return true;
        } catch (moveError) {
            tusErrorLog(`Error moving file ${file.id} to ${finalFilePath}`, moveError);
            return false;
        }
    } catch (e) {
        tusErrorLog('Unhandled error in processTusFile', e);
        return false;
    }
}

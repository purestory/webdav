const tus = require('@tus/server');
const TusServer = tus.Server;
const EVENTS = tus.EVENTS;
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs'); // 동기식 fs 추가

// 유틸리티 함수 초기화 (server.js에서 받을 객체 준비)
let utilFunctions = {
    log: console.log,
    errorLog: console.error,
    sanitizeFilename: (filename) => filename,
    updateDiskUsage: async () => true
};

// --- 로깅 향상을 위한 래퍼 함수 ---
function tusLog(message, level = 'info') {
    try {
        // 콘솔에 항상 출력 (트러블슈팅용)
        console.log(`[TUS] ${message}`);
        // 로그 함수 호출
        if (typeof utilFunctions.log === 'function') {
            utilFunctions.log(`[TUS] ${message}`, level);
        }
    } catch (e) {
        console.error(`TUS 로깅 오류: ${e.message}`);
    }
}

function tusErrorLog(message, error) {
    try {
        // 콘솔에 항상 출력
        console.error(`[TUS ERROR] ${message}`, error);
        // 에러 로그 함수 호출
        if (typeof utilFunctions.errorLog === 'function') {
            utilFunctions.errorLog(`[TUS] ${message}`, error);
        }
    } catch (e) {
        console.error(`TUS 에러 로깅 오류: ${e.message}`);
    }
}

// --- Configuration ---
const tusStorageDir = path.join(__dirname, 'tus-storage'); // Directory for temporary TUS uploads
const finalStorageDir = path.join(__dirname, 'share-folder'); // Final destination
const tusApiPath = '/api/tus/upload'; // 끝 슬래시 제거

// Ensure TUS storage directory exists (동기식)
function ensureTusStorageDir() {
    try {
        if (!fsSync.existsSync(tusStorageDir)) {
            fsSync.mkdirSync(tusStorageDir, { recursive: true });
            tusLog(`TUS storage directory created: ${tusStorageDir}`, 'info');
        } else {
            tusLog(`TUS storage directory exists: ${tusStorageDir}`, 'info');
        }
        return true;
    } catch (error) {
        tusErrorLog('Failed to create TUS storage directory', error);
        return false;
    }
}

// --- 글로벌 TUS 서버 인스턴스 생성 (모듈 레벨에서 유지) ---
let tusServer = null;

// 파일 존재 여부 확인 유틸리티 함수
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

// 현재 처리 중인 파일을 추적하기 위한 Map
const processingFiles = new Map();

// --- TUS 핸들러 함수 (외부 이벤트 루프에서 안전하게 호출 가능) ---
// 업로드 완료 핸들러 함수 개선
// --- TUS 핸들러 함수 (개선) ---
function handleCompletedUpload(file) {
    // <<<--- 추가된 로그 (호출 확인) --->>>
    tusLog(`[EVENT_HANDLER_CALLED] handleCompletedUpload called. Received file object: ${JSON.stringify(file)}`, 'debug'); 

    if (!file || !file.id) {
        tusErrorLog('Invalid or incomplete file object received in handleCompletedUpload', null);
        return; // 유효하지 않은 객체면 처리 중단
    }
    
    // <<<--- 추가된 로그 (메타데이터 확인) --->>>
    tusLog(`handleCompletedUpload: File ID: ${file.id}, Metadata: ${JSON.stringify(file.metadata)}, Size: ${file.size}`, 'info');

    // 이미 처리 중인 파일인지 확인
    if (processingFiles.has(file.id)) {
        tusLog(`File ${file.id} is already being processed, skipping`, 'warn');
        return;
    }

    // 처리 시작 시간 기록
    const startTime = Date.now();
    
    // 처리 중인 파일로 표시
    processingFiles.set(file.id, { 
        startTime: startTime,
        status: 'processing' 
    });
    
    tusLog(`Starting to process file ${file.id}, marked as processing`, 'info');

    // 비동기 처리 즉시 시작 (Promise 체인 사용)
    Promise.resolve()
        // 이전에 제안한 개선된 processTusFile 함수 사용
        .then(() => processTusFile(file)) 
        .then(result => {
            const processingTime = Date.now() - startTime;
            tusLog(`File ${file.id} processing finished in ${processingTime}ms with result: ${result ? 'success' : 'failure'}`, 'info');
            return result;
        })
        .catch(error => {
            tusErrorLog(`Unhandled error during processTusFile chain for ${file.id}: ${error.message}`, error);
             // 실패 시에도 finally 블록 실행됨
            return false; 
        })
        .finally(() => {
            processingFiles.delete(file.id);
            tusLog(`Removed file ${file.id} from processing map`, 'debug');
        });
}







// --- 파일 처리 함수 (공통화) ---
// --- 파일 처리 함수 개선 (폴더 인식 추가) ---
async function processTusFile(file) {
    try {
        const startTime = Date.now();
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

        // 소스 파일 확인
        const sourcePath = path.join(tusStorageDir, file.id);
        if (!fsSync.existsSync(sourcePath)) {
            tusErrorLog(`Source file not found: ${sourcePath}`, null);
            return false;
        }
        
        const stats = fsSync.statSync(sourcePath);
        tusLog(`Source file size: ${stats.size} bytes`, 'info');
        
        // 폴더 처리 (0바이트 파일)
        if (stats.size === 0) {
            tusLog(`Detected directory: ${decodedRelativePath}`, 'info');
            const dirPath = path.join(finalStorageDir, targetPathBase, decodedRelativePath);
            
            try {
                if (!fsSync.existsSync(dirPath)) {
                    await fs.mkdir(dirPath, { recursive: true, mode: 0o777 });
                    tusLog(`Created directory: ${dirPath}`, 'info');
                } else {
                    tusLog(`Directory already exists: ${dirPath}`, 'info');
                }
                
                // 소스 파일(디렉토리 플레이스홀더) 및 메타데이터 삭제
                await fs.unlink(sourcePath);
                tusLog(`Empty directory placeholder file deleted: ${sourcePath}`, 'info');
                
                const metaFile = path.join(tusStorageDir, `${file.id}.json`);
                if (fsSync.existsSync(metaFile)) {
                    await fs.unlink(metaFile);
                    tusLog(`Metadata file deleted: ${metaFile}`, 'info');
                }
                
                return true;
            } catch (dirError) {
                tusErrorLog(`Error creating directory: ${dirError.message}`, dirError);
                return false;
            }
        }
        
        // 일반 파일 처리
        tusLog(`Processing file: ${originalFilename}, Path: ${targetPathBase}, RelativePath: ${decodedRelativePath}`, 'info');

        // 2. 최종 경로 계산
        const sanitizedFilename = utilFunctions.sanitizeFilename(path.basename(decodedRelativePath));
        let dirPath = '';
        
        // 경로 구분자 정규화 (Windows/Unix 모두 처리)
        if (decodedRelativePath.includes('/') || decodedRelativePath.includes('\\')) {
            // 모든 백슬래시를 슬래시로 변환
            const normalizedPath = decodedRelativePath.replace(/\\/g, '/');
            dirPath = path.dirname(normalizedPath);
            dirPath = dirPath === '.' ? '' : dirPath;
        }
        
        const finalDirPath = path.join(finalStorageDir, targetPathBase, dirPath);
        const finalFilePath = path.join(finalDirPath, sanitizedFilename);
        
        tusLog(`Final directory: ${finalDirPath}`, 'info');
        tusLog(`Final file path: ${finalFilePath}`, 'info');

        // 3. 대상 디렉토리 생성
        try {
            if (!fsSync.existsSync(finalDirPath)) {
                await fs.mkdir(finalDirPath, { recursive: true, mode: 0o777 });
                tusLog(`Created destination directory: ${finalDirPath}`, 'info');
            }
        } catch (mkdirError) {
            tusErrorLog(`Error creating directory ${finalDirPath}: ${mkdirError.message}`, mkdirError);
            return false;
        }

        // 4. 파일 이동
        try {
            // 파일 존재 여부 확인
            const fileAlreadyExists = fsSync.existsSync(finalFilePath);
            let targetPath = finalFilePath;
            
            if (fileAlreadyExists) {
                // 충돌 처리: 타임스탬프 추가
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const fileExt = path.extname(finalFilePath);
                const fileBase = path.basename(finalFilePath, fileExt);
                targetPath = path.join(
                    path.dirname(finalFilePath),
                    `${fileBase}_${timestamp}${fileExt}`
                );
                
                tusLog(`File already exists, saving as: ${targetPath}`, 'warn');
            }
            
            // 1. 먼저 fs.rename 시도 (가장 효율적)
            try {
                await fs.rename(sourcePath, targetPath);
                tusLog(`File moved successfully (rename): ${targetPath}`, 'info');
                const targetStats = fsSync.statSync(targetPath);
                tusLog(`Final file size: ${targetStats.size} bytes`, 'info');
            } catch (renameError) {
                // EXDEV 오류(크로스 디바이스 이동) 또는 기타 오류 시 복사+삭제 시도
                tusLog(`fs.rename failed (${renameError.code}): ${renameError.message}, trying copy+delete`, 'warn');
                
                // 2. 파일 복사 시도
                try {
                    await fs.copyFile(sourcePath, targetPath);
                    tusLog(`File copied successfully: ${targetPath}`, 'info');
                    
                    // 소스 파일이 성공적으로 복사되었는지 확인
                    if (fsSync.existsSync(targetPath)) {
                        const targetStats = fsSync.statSync(targetPath);
                        const sourceStats = fsSync.statSync(sourcePath);
                        
                        if (targetStats.size === sourceStats.size) {
                            tusLog(`Verified target file size: ${targetStats.size} bytes`, 'debug');
                            
                            // 소스 파일 삭제
                            await fs.unlink(sourcePath);
                            tusLog(`Source file deleted: ${sourcePath}`, 'debug');
                        } else {
                            throw new Error(`Size mismatch after copy: source=${sourceStats.size}, target=${targetStats.size}`);
                        }
                    } else {
                        throw new Error('Target file not created after copy');
                    }
                } catch (copyError) {
                    // 3. Node.js 방식 실패 시 시스템 명령어로 시도
                    tusErrorLog(`fs.copyFile failed: ${copyError.message}`, copyError);
                    
                    const { exec } = require('child_process');
                    const util = require('util');
                    const execPromise = util.promisify(exec);
                    
                    tusLog(`Trying system cp command for: ${file.id}`, 'warn');
                    // 안전한 명령어 실행을 위해 따옴표 사용
                    const cpCommand = `cp -a "${sourcePath}" "${targetPath}"`;
                    
                    try {
                        const { stdout, stderr } = await execPromise(cpCommand);
                        
                        if (stdout) {
                            tusLog(`cp command output: ${stdout.trim()}`, 'debug');
                        }
                        
                        if (stderr && stderr.trim()) {
                            tusErrorLog(`cp command stderr: ${stderr.trim()}`, null);
                        }
                        
                        // 파일 존재 및 크기 검증
                        if (fsSync.existsSync(targetPath)) {
                            const targetStats = fsSync.statSync(targetPath);
                            const sourceStats = fsSync.statSync(sourcePath);
                            
                            if (targetStats.size === sourceStats.size) {
                                // 원본 삭제
                                await execPromise(`rm "${sourcePath}"`);
                                tusLog(`Removed source file using system rm: ${sourcePath}`, 'debug');
                            } else {
                                throw new Error(`Size mismatch after system cp: source=${sourceStats.size}, target=${targetStats.size}`);
                            }
                        } else {
                            throw new Error('Target file not created after system cp');
                        }
                    } catch (cpError) {
                        tusErrorLog(`System cp/rm failed: ${cpError.message}`, cpError);
                        return false;
                    }
                }
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
            
            const processingTime = Date.now() - startTime;
            tusLog(`File processing completed in ${processingTime}ms: ${path.basename(targetPath)}`, 'info');
            return true;
        } catch (moveError) {
            tusErrorLog(`Error moving file ${file.id} to ${finalFilePath}: ${moveError.message}`, moveError);
            return false;
        }
    } catch (e) {
        tusErrorLog(`Unhandled error in processTusFile: ${e.message}`, e);
        return false;
    }
}













// TUS 서버 초기화 함수 (항상 새로 생성)
function initTusServer() {
    try {
        // 이전 서버 인스턴스 정리
        tusServer = null;
        
        // 새 인스턴스 생성
        tusServer = new TusServer({
            path: tusApiPath,
            datastore: new FileStore({
                directory: tusStorageDir,
            }),
            // 해시 ID를 직접 지원하고 타임스탬프도 지원
            namingFunction: (req) => {
                return Date.now().toString();
            },
            respectForwardedHeaders: true
        });
        
        // 명시적 이벤트 리스너로 모든 TUS 이벤트 로깅
        for (const eventKey in EVENTS) {
            tusServer.on(EVENTS[eventKey], (event) => {
                tusLog(`TUS EVENT: ${eventKey} for file ID: ${event.file?.id || 'unknown'}`, 'info');
                
                // 업로드 완료 이벤트 특별 처리
                if (eventKey === 'EVENT_UPLOAD_COMPLETE') {
                    if (event.file && event.file.size > 0) {
                        // 실제 파일인 경우만 처리
                        handleCompletedUpload(event.file);
                    } else if (event.file) {
                        // 0바이트는 폴더일 가능성 체크
                        handleDirectoryCreation(event.file);
                    }
                }
            });
        }
        
        // 기존 이벤트 리스너도 유지 (이중 보험)
        tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, (event) => {
            tusLog(`Direct EVENT_UPLOAD_COMPLETE for file: ${event.file?.id || 'unknown'}`, 'info');
            if (event.file && event.file.size > 0) {
                handleCompletedUpload(event.file);
            } else if (event.file) {
                handleDirectoryCreation(event.file);
            }
        });
        
        tusLog('TUS server initialized successfully', 'info');
        return true;
    } catch (error) {
        tusErrorLog('Failed to initialize TUS server', error);
        return false;
    }
}


// 폴더 처리 전용 함수
async function handleDirectoryCreation(file) {
    try {
        if (!file || !file.id) {
            tusErrorLog('Invalid file object received in handleDirectoryCreation', null);
            return false;
        }
        
        const metadata = file.metadata || {};
        if (!metadata.filename) {
            tusErrorLog(`Missing filename in metadata for directory ID: ${file.id}`, null);
            return false;
        }
        
        // 폴더 경로 계산
        const targetPathBase = metadata.targetPath || '';
        let dirName;
        
        try {
            dirName = metadata.relativePath ? 
                decodeURIComponent(metadata.relativePath) : metadata.filename;
        } catch (e) {
            tusErrorLog(`Failed to decode directory path: ${metadata.relativePath}`, e);
            return false;
        }
        
        tusLog(`Processing directory: ${dirName}, in path: ${targetPathBase}`, 'info');
        
        // 폴더 생성
        const dirFullPath = path.join(finalStorageDir, targetPathBase, dirName);
        
        if (!fsSync.existsSync(dirFullPath)) {
            await fs.mkdir(dirFullPath, { recursive: true, mode: 0o777 });
            tusLog(`Created directory: ${dirFullPath}`, 'info');
        } else {
            tusLog(`Directory already exists: ${dirFullPath}`, 'info');
        }
        
        // 임시 파일 및 메타데이터 정리
        const sourcePath = path.join(tusStorageDir, file.id);
        if (fsSync.existsSync(sourcePath)) {
            await fs.unlink(sourcePath);
            tusLog(`Removed temporary directory placeholder: ${sourcePath}`, 'debug');
        }
        
        const metaFile = path.join(tusStorageDir, `${file.id}.json`);
        if (fsSync.existsSync(metaFile)) {
            await fs.unlink(metaFile);
            tusLog(`Removed directory metadata: ${metaFile}`, 'debug');
        }
        
        return true;
    } catch (error) {
        tusErrorLog(`Error handling directory creation: ${error.message}`, error);
        return false;
    }
}



// 기존 파일 처리 함수
// 서버 시작 시 기존 파일 처리
function processExistingFiles() {
    setTimeout(async () => {
        try {
            const files = fsSync.readdirSync(tusStorageDir);
            
            // 메타데이터 파일 목록
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            tusLog(`Found ${jsonFiles.length} metadata files to process`, 'info');
            
            // 파일 ID 추출 (확장자 제외)
            const fileIds = new Set(files.filter(file => !file.endsWith('.json')));
            tusLog(`Found ${fileIds.size} actual files in storage`, 'info');
            
            for (const jsonFile of jsonFiles) {
                try {
                    const fileId = path.basename(jsonFile, '.json');
                    const filePath = path.join(tusStorageDir, fileId);
                    
                    // 파일과 메타데이터가 모두 존재하는지 확인
                    if (fileIds.has(fileId)) {
                        const metadataPath = path.join(tusStorageDir, jsonFile);
                        const metadataContent = await fs.readFile(metadataPath, 'utf8');
                        const fileData = JSON.parse(metadataContent);
                        
                        // 파일 크기와 상태 확인
                        const fileStats = fsSync.statSync(filePath);
                        tusLog(`File ${fileId}: size=${fileData.size}, actual=${fileStats.size}, offset=${fileData.offset || 'unknown'}`, 'debug');
                        
                        // 완료된 파일 또는 0바이트 파일(폴더) 처리
                        if (fileData.size === 0) {
                            // 폴더로 처리
                            tusLog(`Processing directory: ${fileId}`, 'info');
                            handleDirectoryCreation({ 
                                id: fileId, 
                                metadata: fileData.metadata || {},
                                size: 0
                            });
                        } else if (fileData.offset === fileData.size || fileData.offset === undefined) {
                            // 완료된 파일로 처리
                            tusLog(`Processing completed file: ${fileId}`, 'info');
                            handleCompletedUpload({ 
                                id: fileId, 
                                metadata: fileData.metadata || {},
                                size: fileData.size
                            });
                        } else {
                            tusLog(`Skipping incomplete file: ${fileId} (${fileData.offset || 0}/${fileData.size})`, 'debug');
                        }
                    } else {
                        tusLog(`Metadata without file: ${jsonFile}`, 'warn');
                    }
                } catch (e) {
                    tusErrorLog(`Error processing file: ${jsonFile}`, e);
                }
            }
        } catch (e) {
            tusErrorLog('Error processing existing files', e);
        }
    }, 2000);
}



// 서버 실행 시 즉시 기존 파일 처리 (추가)
setTimeout(() => {
    tusLog('Running immediate file check...', 'info');
    processExistingFiles();
}, 1000);






// 마운트 함수 (utilFunctions 매개변수 추가)
// 마운트 함수 (utilFunctions 매개변수 추가)
function mountTusServer(app, utils = {}) {
    try {
        utilFunctions = { ...utilFunctions, ...utils }; // 유틸리티 함수 병합
        // 로깅 함수 재설정 (utils에서 새로운 함수가 제공될 수 있음)
        tusLog = utilFunctions.log || console.log;
        tusErrorLog = utilFunctions.errorLog || console.error;

        // === 수정 시작 ===
        // 1. initTusServer() 호출하고 성공 여부만 확인
        const isInitialized = initTusServer(); 
        if (!isInitialized) {
            // 초기화 실패 시 오류 발생시키고 마운트 중단
            throw new Error("Failed to initialize TUS server instance.");
        }
        // initTusServer 내부에서 모듈 레벨 tusServer 변수에 인스턴스가 할당됨
        
        // 2. 모듈 레벨 tusServer 변수가 실제 인스턴스인지 다시 확인 (방어 코드)
        if (!tusServer) {
            throw new Error("TUS server instance is not available after initialization.");
        }
        // === 수정 끝 ===

        tusLog('TUS server instance initialized successfully', 'info');

        // --- 이벤트 리스너 등록 ---
        tusLog('Registering TUS event listeners...', 'debug');

        // <<<--- 중요: 업로드 완료 이벤트 핸들러 --->>>
        // === 수정: 모듈 레벨 tusServer 변수 사용 ===
        tusServer.on(EVENTS.POST_FINISH, (req, res, upload) => {
            tusLog(`[TUS_EVENT] POST_FINISH triggered. Upload object: ${JSON.stringify(upload)}`, 'info'); 

            if (upload && upload.id) {
                 const fileInfo = {
                     id: upload.id,
                     metadata: upload.metadata || (req.headers['upload-metadata'] ? parseMetadataString(req.headers['upload-metadata']) : {}), 
                     size: upload.size || (req.headers['upload-length'] ? parseInt(req.headers['upload-length'], 10) : 0) 
                 };
                 tusLog(`Preparing to call handleCompletedUpload with fileInfo: ${JSON.stringify(fileInfo)}`, 'debug');
                 
                 setTimeout(() => {
                     handleCompletedUpload(fileInfo);
                 }, 50); 

            } else {
                 tusErrorLog('POST_FINISH event received without valid upload object or ID', null);
            }
        });
        
        // 다른 이벤트 리스너 (POST_CREATE, POST_RECEIVE 등)
        // === 수정: 모듈 레벨 tusServer 변수 사용 ===
        tusServer.on(EVENTS.POST_CREATE, (req, res, upload) => {
            tusLog(`[TUS_EVENT] POST_CREATE triggered for file ID: ${upload ? upload.id : 'unknown'}`, 'debug');
        });
        
        // === 수정: 모듈 레벨 tusServer 변수 사용 ===
        tusServer.on(EVENTS.POST_RECEIVE, (req, res, upload) => {
             tusLog(`[TUS_EVENT] POST_RECEIVE triggered for file ID: ${upload ? upload.id : 'unknown'}. Offset: ${upload ? upload.offset : 'unknown'}`, 'debug');
        });

        tusLog('TUS event listeners registered successfully', 'debug');

        // 미들웨어로 TUS 서버 마운트
        tusLog(`About to mount TUS server at ${tusApiPath}`, 'info');
        console.log(`[TUS-MOUNT] Mounting TUS server to Express app`);
        
        // TUS 요청 로깅 미들웨어
        app.use(tusApiPath, (req, res, next) => {
             tusLog(`[TUS_REQUEST] ${req.method} ${req.url}, Headers: ${JSON.stringify(req.headers)}`, 'trace'); 
             next();
        });
        
        // TUS 서버 핸들러
        // === 수정: 모듈 레벨 tusServer 변수 사용 ===
        app.all(`${tusApiPath}*`, tusServer.handle.bind(tusServer));
        
        // 기존 파일 처리 로직
        processExistingFiles(); 
        
        tusLog(`TUS server mounted at ${tusApiPath}`, 'info');
        console.log(`[TUS-MOUNT] TUS server successfully mounted at ${tusApiPath}`);
        return true;
    } catch (error) {
        tusErrorLog('Failed to mount TUS server', error);
        console.error('[TUS-MOUNT] Failed to mount TUS server:', error);
        return false;
    }
}

// Upload-Metadata 헤더 파싱 함수 (필요시 추가)
// ... (이하 코드는 변경 없음) ...



// Upload-Metadata 헤더 파싱 함수 (필요시 추가)
function parseMetadataString(metadataString) {
    const metadata = {};
    if (!metadataString) return metadata;
    
    metadataString.split(',').forEach(pair => {
        const parts = pair.split(' ');
        if (parts.length === 2) {
            try {
                // Base64 디코딩
                metadata[parts[0]] = Buffer.from(parts[1], 'base64').toString('utf-8');
            } catch (e) {
                 tusErrorLog(`Failed to decode metadata part: ${pair}`, e);
            }
        }
    });
    return metadata;
}



// 모듈 내보내기 
module.exports = { mountTusServer };
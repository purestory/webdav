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
const tusApiPath = '/api/tus/upload/'; // TUS endpoint path (슬래시로 끝나는 형식)

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
function handleCompletedUpload(file) {
    if (!file || !file.id) {
        tusErrorLog('Invalid file object received in handleCompletedUpload', null);
        return;
    }

    // 이미 처리 중인 파일인지 확인
    if (processingFiles.has(file.id)) {
        tusLog(`File ${file.id} is already being processed, skipping`, 'warn');
        return;
    }

    // 처리 중인 파일로 표시
    processingFiles.set(file.id, true);

    // 비동기 처리 시작
    setTimeout(async () => {
        try {
            tusLog(`Started processing file ID: ${file.id}`, 'info');
            await processTusFile(file);
        } catch (error) {
            tusErrorLog(`Error in handleCompletedUpload for file ${file.id}`, error);
        } finally {
            // 처리 완료 후 Map에서 제거
            processingFiles.delete(file.id);
        }
    }, 100);
}

// --- 파일 처리 함수 (공통화) ---
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
            namingFunction: (req) => {
                return Date.now().toString();
            },
            respectForwardedHeaders: true
        });
        
        // 이벤트 리스너 등록
        tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, (event) => {
            tusLog(`EVENT_UPLOAD_COMPLETE received for file: ${event.file.id}`, 'info');
            handleCompletedUpload(event.file);  // 비동기 핸들러로 처리
        });
        
        // 추가 진단용 이벤트 리스너
        tusServer.on(EVENTS.EVENT_FILE_CREATED, (event) => {
            tusLog(`EVENT_FILE_CREATED for file: ${event.file.id}`, 'debug');
        });
        
        tusLog('TUS server initialized successfully', 'info');
        return true;
    } catch (error) {
        tusErrorLog('Failed to initialize TUS server', error);
        return false;
    }
}

// 마운트 함수 (utilFunctions 매개변수 추가)
function mountTusServer(app, utils = {}) {
    if (!app) {
        tusErrorLog('Cannot mount TUS server: app instance is missing', null);
        return false;
    }
    
    // 유틸리티 함수 설정
    if (utils) {
        if (utils.log) utilFunctions.log = utils.log;
        if (utils.errorLog) utilFunctions.errorLog = utils.errorLog;
        if (utils.sanitizeFilename) utilFunctions.sanitizeFilename = utils.sanitizeFilename;
        if (utils.updateDiskUsage) utilFunctions.updateDiskUsage = utils.updateDiskUsage;
    }
    
    try {
        // 스토리지 디렉토리 확인
        if (!ensureTusStorageDir()) {
            tusErrorLog('TUS storage directory not ready', null);
            return false;
        }
        
        // 서버 초기화
        if (!initTusServer() || !tusServer) {
            tusErrorLog('TUS server initialization failed', null);
            return false;
        }
        
        // 테스트 로그
        tusLog('About to mount TUS server...', 'info');
        console.log('[TUS-MOUNT] Mounting TUS server to Express app');
        
        // 라우트 등록 (handle.bind 방식 대신 직접 처리)
        app.all(`${tusApiPath}*`, (req, res, next) => {
            tusLog(`Request: ${req.method} ${req.url}`, 'debug');
            
            // POST 요청 (파일 생성)
            if (req.method === 'POST' && req.url === tusApiPath) {
                tusLog(`POST 요청 감지: 파일 생성 시작`, 'debug');
            }
            
            // PATCH 요청 (데이터 업로드)
            if (req.method === 'PATCH' && req.url.startsWith(tusApiPath)) {
                const fileId = req.url.replace(tusApiPath, '');
                tusLog(`PATCH 요청 감지: 파일 ID ${fileId} 데이터 업로드`, 'debug');
                
                // 원본 요청 처리 후 완료 이벤트 추가 확인
                res.on('finish', () => {
                    if (res.statusCode === 204) { // 업로드 성공 상태 코드
                        // 메타데이터 파일 확인
                        const metaPath = path.join(tusStorageDir, `${fileId}.json`);
                        if (fsSync.existsSync(metaPath)) {
                            try {
                                const metaContent = fsSync.readFileSync(metaPath, 'utf8');
                                const meta = JSON.parse(metaContent);
                                
                                // 파일 크기 확인 (완료 여부 판단)
                                const dataPath = path.join(tusStorageDir, fileId);
                                if (fsSync.existsSync(dataPath)) {
                                    const dataStats = fsSync.statSync(dataPath);
                                    // 헤더에서 업로드 크기 확인
                                    if (req.headers['upload-length'] && 
                                        dataStats.size.toString() === req.headers['upload-length']) {
                                        tusLog(`PATCH 요청 완료: 파일 ID ${fileId} 업로드 완료됨`, 'info');
                                        
                                        // 파일 처리 트리거
                                        handleCompletedUpload({ 
                                            id: fileId, 
                                            metadata: meta.metadata || {} 
                                        });
                                    }
                                }
                            } catch (e) {
                                tusErrorLog(`메타데이터 파일 처리 오류: ${e.message}`, e);
                            }
                        }
                    }
                });
            }
            
            // TUS 서버에 요청 전달
            return tusServer.handle(req, res, next);
        });
        
        // 기존 파일 처리 (서버 재시작 시)
        setTimeout(async () => {
            try {
                const files = fsSync.readdirSync(tusStorageDir);
                const jsonFiles = files.filter(file => file.endsWith('.json'));
                tusLog(`Found ${jsonFiles.length} incomplete uploads to process`, 'info');
                
                for (const jsonFile of jsonFiles) {
                    const fileId = path.basename(jsonFile, '.json');
                    const filePath = path.join(tusStorageDir, fileId);
                    
                    if (fsSync.existsSync(filePath)) {
                        try {
                            const metadataStr = await fs.readFile(path.join(tusStorageDir, jsonFile), 'utf8');
                            const metadata = JSON.parse(metadataStr);
                            handleCompletedUpload({ id: fileId, metadata: metadata.metadata || {} });
                        } catch (e) {
                            tusErrorLog(`Error processing existing file ${fileId}`, e);
                        }
                    }
                }
            } catch (e) {
                tusErrorLog('Error processing existing files', e);
            }
        }, 2000);
        
        tusLog(`TUS server mounted at ${tusApiPath}`, 'info');
        console.log(`[TUS-MOUNT] TUS server successfully mounted at ${tusApiPath}`);
        return true;
    } catch (error) {
        tusErrorLog('Failed to mount TUS server', error);
        console.error('[TUS-MOUNT] Failed to mount TUS server:', error);
        return false;
    }
}

// 모듈 내보내기
module.exports = { mountTusServer };
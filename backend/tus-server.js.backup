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

// --- 파일 처리 함수 (공통화) ---
async function processTusFile(file) {
    try {
        tusLog(`Upload completed for file ID: ${file.id}`, 'info');
        
        // 1. 메타데이터 추출 및 검증
        const metadata = file.metadata || {};
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
        const sourcePath = path.join(tusStorageDir, file.id);
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
        tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, async (event) => {
            tusLog(`EVENT_UPLOAD_COMPLETE received for file: ${event.file.id}`, 'info');
            await processTusFile(event.file);
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
        
        // 라우트 등록
        app.all(`${tusApiPath}*`, (req, res, next) => {
            tusLog(`Request: ${req.method} ${req.url}`, 'debug');
            return tusServer.handle.bind(tusServer)(req, res, next);
        });
        
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
const express = require('express');
const webdav = require('webdav-server').v2;
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const { execSync, fork } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const app = express();
const PORT = process.env.PORT || 3333;
const archiver = require('archiver');
const { promisify } = require('util');
const fs_stream = require('fs');
const { mountTusServer } = require('./tus-server'); // TUS 서버 모듈 import

// 쉘 인자를 안전하게 이스케이프하는 함수 (추가)

// 특수문자를 완벽하게 이스케이프하는 전역 함수 정의
// 이 함수는 코드 전체에서 재사용됩니다

// --- 전역 오류 처리기 추가 ---
process.on('uncaughtException', (error) => {
  errorLog('처리되지 않은 예외 발생:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  errorLog('처리되지 않은 Promise 거부 발생:', reason);
});

// --- 활성 워커 프로세스 관리 --- 
const activeWorkers = new Set(); // 활성 워커의 참조를 저장할 Set

// --- 초기 디렉토리 설정 및 검사 (비동기 함수) ---
const LOGS_DIRECTORY = path.join(__dirname, 'logs');
const ROOT_DIRECTORY = path.join(__dirname, 'share-folder');
const TMP_UPLOAD_DIR = path.join(__dirname, 'tmp'); // 임시 디렉토리 경로 정의 추가

// *** 로그 파일 스트림 변수 선언 (위치 조정) ***
let logFile;
let errorLogFile;

// *** 로그 스트림 설정 함수 정의 (위치 조정) ***
async function initializeDirectories() {
  try {
    try {
      await fs.promises.access(LOGS_DIRECTORY);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.promises.mkdir(LOGS_DIRECTORY, { recursive: true });
        try { fs.appendFileSync(path.join(__dirname, 'logs', 'server.log'), `${new Date().toISOString()} - 로그 디렉토리 생성됨: ${LOGS_DIRECTORY}\n`); } catch {}
      } else {
        throw error;
      }
    }

    setupLogStreams(); 

    try {
      await fs.promises.access(ROOT_DIRECTORY);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.promises.mkdir(ROOT_DIRECTORY, { recursive: true });
        log(`루트 디렉토리 생성됨: ${ROOT_DIRECTORY}`, 'info'); 
      } else {
        throw error;
      }
    }

    await fs.promises.chmod(ROOT_DIRECTORY, 0o777);
    log(`루트 디렉토리 권한 설정됨: ${ROOT_DIRECTORY}`, 'info');

    try {
      await fs.promises.access(TMP_UPLOAD_DIR);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.promises.mkdir(TMP_UPLOAD_DIR, { recursive: true });
        log(`임시 업로드 디렉토리 생성됨: ${TMP_UPLOAD_DIR}`, 'info');
      } else {
        throw error;
      }
    }

    await loadLockedFolders(); // 서버 시작 시 잠금 목록 로드

  } catch (initError) {
    console.error('초기 디렉토리 설정 중 심각한 오류 발생:', initError);
    process.exit(1);
  }
}


// --- 로그 레벨 및 모드 설정 ---
const LOG_LEVELS = { minimal: 0, info: 1, debug: 2 };
const isDevelopment = process.env.NODE_ENV === 'development';
// !!!! 로그 레벨 기본값을 minimal로 복원 !!!!
let currentLogLevel = LOG_LEVELS.minimal; 
// let currentLogLevel = isDevelopment ? LOG_LEVELS.info : LOG_LEVELS.minimal; // <- 환경 변수 기반 설정은 주석 유지
const requestLogLevel = 'info'; // 요청 로그 레벨은 info 유지

// 로그 레벨 설정 함수
function setLogLevel(levelName) {
  if (LOG_LEVELS.hasOwnProperty(levelName)) {
    currentLogLevel = LOG_LEVELS[levelName];
    log(`Log level set to: ${levelName} (${currentLogLevel})`, 'info'); // 로그 레벨 변경은 info 레벨
  } else {
    errorLog(`Invalid log level specified: ${levelName}. Keeping current level: ${Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLogLevel)}`);
  }
}



function setupLogStreams() {
  logFile = fs.createWriteStream(path.join(LOGS_DIRECTORY, 'server.log'), { flags: 'a' });
  errorLogFile = fs.createWriteStream(path.join(LOGS_DIRECTORY, 'error.log'), { flags: 'a' });
}

// --- 로그 함수 수정 ---
function log(message, levelName = 'debug') {
  const level = LOG_LEVELS[levelName] !== undefined ? LOG_LEVELS[levelName] : LOG_LEVELS.debug;
  if (level > currentLogLevel) return; // 현재 레벨보다 높은 레벨의 로그는 기록하지 않음

  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(now.getTime() + kstOffset);
  const year = kstDate.getUTCFullYear();
  const month = (kstDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = kstDate.getUTCDate().toString().padStart(2, '0');
  const hours = kstDate.getUTCHours().toString().padStart(2, '0');
  const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
  const seconds = kstDate.getUTCSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;

  // 로그 레벨 태그 제거
  const logMessage = `${timestamp} - ${message}\n`;
  logFile.write(logMessage);
}

function logWithIP(message, req, levelName = 'debug') {
  const level = LOG_LEVELS[levelName] !== undefined ? LOG_LEVELS[levelName] : LOG_LEVELS.debug;
  if (level > currentLogLevel) return;

  let ip = 'unknown';
  if (req && req.headers) {
    ip = req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         (req.connection && req.connection.remoteAddress) ||
         (req.socket && req.socket.remoteAddress) ||
         (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
         'unknown';
  }

  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(now.getTime() + kstOffset);
  const year = kstDate.getUTCFullYear();
  const month = (kstDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = kstDate.getUTCDate().toString().padStart(2, '0');
  const hours = kstDate.getUTCHours().toString().padStart(2, '0');
  const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
  const seconds = kstDate.getUTCSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;

  // 로그 레벨 태그 제거, IP 정보는 유지
  const logMessage = `${timestamp} - [IP: ${ip}] ${message}\n`;
  logFile.write(logMessage);
}

// errorLog 함수는 이제 setupLogStreams 호출 후 안전하게 errorLogFile 사용 가능
function errorLog(message, error) { // 오류 로그는 항상 기록
  const now = new Date();
  // *** 누락된 timestamp 생성 로직 추가 ***
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(now.getTime() + kstOffset);
  const year = kstDate.getUTCFullYear();
  const month = (kstDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = kstDate.getUTCDate().toString().padStart(2, '0');
  const hours = kstDate.getUTCHours().toString().padStart(2, '0');
  const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
  const seconds = kstDate.getUTCSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;
  // *** 로직 추가 끝 ***
  
  const logMessage = `${timestamp} - ERROR: ${message} - ${error ? (error.stack || error.message || error) : 'Unknown error'}\n`;
  
  if (errorLogFile && errorLogFile.writable) { 
    errorLogFile.write(logMessage);
  } else {
    console.error(message, error);
  }
}

function errorLogWithIP(message, error, req) { // 오류 로그는 항상 기록
  // ... (ip 생성 로직) ...
  let ip = 'unknown';
  if (req && req.headers) {
      ip = req.headers['x-forwarded-for'] ||
           req.headers['x-real-ip'] ||
           (req.connection && req.connection.remoteAddress) ||
           (req.socket && req.socket.remoteAddress) ||
           (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
           'unknown';
  }

  const now = new Date();
  // *** 누락된 timestamp 생성 로직 추가 ***
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(now.getTime() + kstOffset);
  const year = kstDate.getUTCFullYear();
  const month = (kstDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = kstDate.getUTCDate().toString().padStart(2, '0');
  const hours = kstDate.getUTCHours().toString().padStart(2, '0');
  const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
  const seconds = kstDate.getUTCSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;
  // *** 로직 추가 끝 ***

  const logMessage = `${timestamp} - ERROR: [IP: ${ip}] ${message} - ${error ? (error.stack || error.message || error) : 'Unknown error'}\n`;

  if (errorLogFile && errorLogFile.writable) {
    errorLogFile.write(logMessage);
  } else {
    console.error(`[IP: ${ip}] ${message}`, error);
  }
}




// 최대 저장 용량 설정 (100GB)
const MAX_STORAGE_SIZE = 100 * 1024 * 1024 * 1024; // 100GB in bytes

// 최대 파일명/경로 길이 제한 설정 (전역으로 이동)
const MAX_FILENAME_BYTES = 229;
const MAX_PATH_BYTES = 3800; // 일반적인 최대값보다 안전한 값으로 설정
const TRUNCATE_MARKER = '...'; // *** 누락된 상수 정의 추가 ***

async function getDiskUsage() {
  // const forceLogLevel = 'minimal'; // 로그 레벨 무시하고 항상 출력 <- 제거
  let commandOutput = null; // exec 결과 저장 변수

  try {
    const command = `du -sb ${ROOT_DIRECTORY}`;
    log(`[DiskUsage] Executing command: ${command}`, 'debug'); // 레벨 변경

    // *** exec 결과 전체 로깅 ***
    commandOutput = await exec(command);
    log(`[DiskUsage] exec result: ${JSON.stringify(commandOutput)}`, 'debug'); // 레벨 변경

    const { stdout, stderr } = commandOutput;
    const stdoutTrimmed = stdout ? stdout.trim() : ''; // stdout이 null/undefined일 경우 대비

    log(`[DiskUsage] Raw stdout: [${stdoutTrimmed}]`, 'debug'); // 레벨 변경
    if (stderr) {
      // Optional chaining 추가
      errorLog(`[DiskUsage] du command stderr: [${stderr?.trim()}]`); 
    }

    // 파싱 시도
    const outputString = stdoutTrimmed;
    const match = outputString.match(/^(\d+)/); 
    const parsedValue = match ? match[1] : null; // 파싱된 숫자 문자열
    log(`[DiskUsage] Parsed value string: ${parsedValue}`, 'debug'); // 레벨 변경

    const usedBytes = parsedValue ? parseInt(parsedValue, 10) : NaN;
    log(`[DiskUsage] Parsed usedBytes (number): ${usedBytes}`, 'debug'); // 레벨 변경

    if (isNaN(usedBytes)) {
      errorLog('[DiskUsage] 디스크 사용량 파싱 오류: 숫자로 변환 실패', { stdout: outputString });
      throw new Error('Failed to parse disk usage output.');
    }

    log(`[DiskUsage] 디스크 사용량 조회 (파싱 성공): ${usedBytes} bytes`, 'info'); // 최종 결과는 info 레벨로 유지

    return {
      used: usedBytes,
      total: MAX_STORAGE_SIZE,
      available: MAX_STORAGE_SIZE - usedBytes,
      percent: Math.round((usedBytes / MAX_STORAGE_SIZE) * 100)
    };
  } catch (error) {
    errorLog('[DiskUsage] 디스크 사용량 확인 오류:', { 
        message: error.message, 
        stack: error.stack,
        execResult: commandOutput // 오류 발생 시 exec 결과도 로깅
    });
    return {
      used: 0,
      total: MAX_STORAGE_SIZE,
      available: MAX_STORAGE_SIZE,
      percent: 0
    };
  }
}


// WebDAV 서버 설정
const server = new webdav.WebDAVServer({
  httpAuthentication: new webdav.HTTPBasicAuthentication(
    async (username, password) => {
      // 간단한 사용자 인증 (실제 서비스에서는 보안을 강화해야 함)
      return username === 'admin' && password === 'admin';
    }
  )
});

// WebDAV 파일시스템 설정
const fileSystem = new webdav.PhysicalFileSystem(ROOT_DIRECTORY);
server.setFileSystem('/', fileSystem);

// CORS 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Destination, Overwrite');
  
  // OPTIONS 요청 처리
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  next();
});

// 용량 확인 미들웨어
app.use((req, res, next) => {
  // 파일 업로드 요청의 경우 용량 체크 - 일시적으로 주석 처리
  /*
  if (req.method === 'POST' && req.path === '/api/upload') {
    const diskUsage = getDiskUsage();
    
    // Content-Length 헤더가 있으면 업로드 크기 체크
    if (req.headers['content-length']) {
      const uploadSize = parseInt(req.headers['content-length']);
      
      // 업로드 후 용량 초과 확인
      if (diskUsage.used + uploadSize > MAX_STORAGE_SIZE) {
        return res.status(507).json({
          error: '저장 공간 부족',
          message: '저장 공간이 부족합니다. 파일을 삭제하고 다시 시도해 주세요.',
          diskUsage
        });
      }
    }
  }
  */
  
  next();
});

// Express 내장 body-parser 설정 (크기 제한 증가)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 임시 업로드 디렉토리 설정 (제거)
// const TMP_UPLOAD_DIR = path.join(__dirname, 'tmp');

// --- UTF-8 문자열 바이트 단위 자르기 헬퍼 함수 ---
function truncateBytes(str, maxBytes) {
    const buffer = Buffer.from(str, 'utf8');
    if (buffer.length <= maxBytes) {
        return str;
    }
    
    // maxBytes까지 자르되, 마지막 문자가 깨지지 않도록 조정
    let truncatedBytes = 0;
    let lastValidEnd = 0;
    for (let i = 0; i < buffer.length; ) {
        // 현재 문자의 바이트 길이 확인 (UTF-8)
        let charBytes = 1;
        if ((buffer[i] & 0xE0) === 0xC0) charBytes = 2;
        else if ((buffer[i] & 0xF0) === 0xE0) charBytes = 3;
        else if ((buffer[i] & 0xF8) === 0xF0) charBytes = 4;
        
        // 다음 문자를 포함해도 maxBytes를 넘지 않으면 진행
        if (truncatedBytes + charBytes <= maxBytes) {
            truncatedBytes += charBytes;
            lastValidEnd = i + charBytes;
            i += charBytes;
        } else {
            // 넘으면 현재 위치에서 중단
            break;
        }
    }
    // 마지막 유효 문자까지만 잘라서 반환
    return buffer.slice(0, lastValidEnd).toString('utf8');
}

// --- 쉘 인자 이스케이프 함수 정의 ---

// Multer 설정 (Disk Storage 사용 - 파일명 자동 자르기 추가)
const storage = multer.diskStorage({
  destination: async function (req, file, cb) { // *** async 추가 ***
    // 각 요청별 고유 임시 디렉토리 생성
    if (!req.uniqueTmpDir) {
      const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(2, 15);
      req.uniqueTmpDir = path.join(TMP_UPLOAD_DIR, uniqueId);
      try {
        // *** mkdir 비동기화 ***
        await fs.promises.mkdir(req.uniqueTmpDir, { recursive: true });
        logWithIP(`[Multer] 요청별 임시 디렉토리 생성: ${req.uniqueTmpDir}`, req);
      } catch (mkdirError) {
        errorLogWithIP('[Multer] 임시 디렉토리 생성 오류', mkdirError, req);
        return cb(mkdirError); // *** 에러 콜백 호출 ***
      }
    }
    cb(null, req.uniqueTmpDir); // *** 성공 콜백 호출 ***
  },
  filename: function (req, file, cb) {
    // 원본 파일명에서 확장자 분리
    const originalName = file.originalname;
    const parsedPath = path.parse(originalName);
    const originalExt = parsedPath.ext; // 예: '.txt'
    const originalNameWithoutExt = parsedPath.name; // 확장자 제외 이름
    
    // 1. 특수문자 제거 (기존 로직 유지)
    let safeNameWithoutExt = originalNameWithoutExt.replace(/[/\\:*?\"<>|]/g, '_');

    // 2. 파일명 길이 자르기 (바이트 기준)
    const markerBytes = Buffer.byteLength(TRUNCATE_MARKER, 'utf8');
    const extBytes = Buffer.byteLength(originalExt, 'utf8');
    // 이름 부분에 허용되는 최대 바이트 (마커와 확장자 길이 고려)
    // 마커를 추가해야 하는 경우에만 마커 길이를 뺌
    let maxNameBytes = MAX_FILENAME_BYTES - extBytes;
    if (Buffer.byteLength(safeNameWithoutExt, 'utf8') > maxNameBytes) {
         maxNameBytes -= markerBytes; 
    }
    
    let finalNameWithoutExt = safeNameWithoutExt;
    if (Buffer.byteLength(safeNameWithoutExt, 'utf8') > maxNameBytes && maxNameBytes > 0) {
        finalNameWithoutExt = truncateBytes(safeNameWithoutExt, maxNameBytes);
        // 잘렸으면 마커 추가
        if (finalNameWithoutExt !== safeNameWithoutExt) {
            finalNameWithoutExt += TRUNCATE_MARKER;
            logWithIP(`[Multer Filename] 이름 잘림(바이트): '${safeNameWithoutExt}' -> '${finalNameWithoutExt}'`, req, 'warning');
        }
    } else if (maxNameBytes <= 0) {
        // 확장자(+마커) 길이만으로도 최대 길이를 초과하면 이름 부분을 비움
        finalNameWithoutExt = TRUNCATE_MARKER; // 최소한 마커는 표시
        logWithIP(`[Multer Filename] 확장자가 너무 길어 이름 비움: '${safeNameWithoutExt}' -> '${finalNameWithoutExt}'`, req, 'warning');
    }
    
    // 최종 파일명 조합 (고유 Prefix + 잘린 이름 + 확장자)
    // 임시 폴더 내에서는 유니크한 파일명만 사용
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 9);
    const finalFilename = `tmp_${timestamp}_${randomString}${originalExt}`;
    
    // 원본 파일명은 req.files에서 나중에 접근할 수 있도록 설정
    file.originalFilename = originalName;
    
    logWithIP(`[Multer Filename] 임시 파일명 생성: ${finalFilename}`, req, 'debug');
    cb(null, finalFilename);
  }
});

const uploadMiddleware = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB
    fieldSize: 50 * 1024 * 1024 // 50MB (이전 설정 유지)
  }
});

// 기본 미들웨어 설정
app.use(express.static(path.join(__dirname, '../frontend')));

// --- 로그 미들웨어 (모드 기반 레벨 적용 및 원래 방식으로 복원) ---
app.use((req, res, next) => {
  logWithIP(`${req.method} ${req.url}`, req, requestLogLevel);
  res.on('finish', () => {
    logWithIP(`${req.method} ${req.url} - ${res.statusCode}`, req, requestLogLevel);
  });
  next();
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// 파일 업로드 API 수정 (비동기화 및 병렬 처리 제한)
app.post('/api/upload', uploadMiddleware.any(), async (req, res) => {
  // *** 동적 import 추가 ***
  const pLimit = (await import('p-limit')).default;

  // *** 전체 핸들러 로직을 감싸는 try 블록 시작 (기존 유지) ***
  try {
    // minimal 레벨 로그: 요청 시작/종료는 로깅 미들웨어에서 처리

    // 1. 기존 오류 처리 및 정보 파싱 (이전 상태로 복구)
    if (!req.files || req.files.length === 0) {
      errorLogWithIP('업로드 요청에 파일이 없거나 처리 중 오류 발생.', null, req);
      return res.status(400).json({ error: '파일이 없거나 업로드 처리 중 오류가 발생했습니다.' }); 
    }
    if (!req.body.fileInfo) {
      errorLogWithIP('업로드 요청에 파일 정보(fileInfo)가 없습니다.', null, req);
      return res.status(400).json({ error: '파일 정보가 누락되었습니다.' });
    }

    // !!!! 추가: 프론트엔드에서 받은 경로 및 파일 정보 로깅 !!!!
    const baseUploadPath = req.body.path || '';
    logWithIP(`[Frontend Data] Received base path: '${baseUploadPath}'`, req, 'debug');
    logWithIP(`[Frontend Data] Received fileInfo (raw): ${req.body.fileInfo}`, req, 'debug');

    const rootUploadDir = path.join(ROOT_DIRECTORY, baseUploadPath);
    let fileInfoArray;
    try {
      fileInfoArray = JSON.parse(req.body.fileInfo);
      // !!!! 추가: 파싱된 파일 정보 로깅 !!!!
      logWithIP(`[Frontend Data] Parsed fileInfo: ${JSON.stringify(fileInfoArray, null, 2)}`, req, 'debug');

      // --- 추가: minimal 레벨 작업 상세 로그 (파일명 포함) ---
      const fileCount = fileInfoArray.length;
      let fileSummary = '';
      if (fileCount > 0) {
          if (fileCount <= 3) {
              fileSummary = fileInfoArray.map(f => `'${f.originalName}'`).join(', ');
          } else {
              fileSummary = fileInfoArray.slice(0, 3).map(f => `'${f.originalName}'`).join(', ') + ` 외 ${fileCount - 3}개`;
          }
      } else {
          fileSummary = '0개'; // 파일이 없는 경우
      }
      logWithIP(`[Upload Request] ${fileSummary} 파일 업로드 요청 (${baseUploadPath || '루트'})`, req, 'info'); // 레벨 변경: minimal -> info
      // ----------------------------------------------
      logWithIP(`[Upload Start] 파일 정보 수신: ${fileInfoArray.length}개 항목`, req, 'info');
    } catch (parseError) {
      errorLogWithIP('fileInfo JSON 파싱 오류:', parseError, req);
      return res.status(400).json({ error: '잘못된 파일 정보 형식입니다.' });
    }
    logWithIP(`기본 업로드 경로: ${baseUploadPath || '루트'}, 절대 경로: ${rootUploadDir}`, req);

    // 2. 처리 변수 초기화 (이전 상태로 복구)
    const processedFiles = [];
    const errors = [];

    // 파일명 길이 제한 함수 (바이트 기준)
    function truncateFileName(filename) {
      // !!!! 수정: 백슬래시도 경로 구분 문자로 처리 !!!!
      const sanitizedFilename = filename.replace(/[\\/]/g, '_'); // <- 정규식 수정 (백슬래시 이스케이프)

      const originalBytes = Buffer.byteLength(sanitizedFilename);
      log(`[Filename Check] 파일명 길이 확인 시작: ${sanitizedFilename} (${originalBytes} bytes)`, 'debug');
      if (originalBytes <= MAX_FILENAME_BYTES) {
        return sanitizedFilename;
      }
      const extension = sanitizedFilename.lastIndexOf('.') > 0 ? sanitizedFilename.substring(sanitizedFilename.lastIndexOf('.')) : '';
      const nameWithoutExt = sanitizedFilename.substring(0, sanitizedFilename.lastIndexOf('.') > 0 ? sanitizedFilename.lastIndexOf('.') : sanitizedFilename.length);
      let truncatedName = nameWithoutExt;
      while (Buffer.byteLength(truncatedName + '...' + extension) > MAX_FILENAME_BYTES) {
        truncatedName = truncatedName.slice(0, -1);
        if (truncatedName.length === 0) break;
      }
      const newFileName = truncatedName + '...' + extension;
      log(`[Filename Check] 파일명 길이 제한 결과: '${newFileName}' (${Buffer.byteLength(newFileName)} bytes)`, 'debug');
      return newFileName;
    }

    // 경로 길이 확인 및 제한 함수
    function checkAndTruncatePath(fullPath) {
      const fullPathBytes = Buffer.byteLength(fullPath);
      log(`[Path Check] 경로 길이 확인 시작: ${fullPath} (${fullPathBytes} bytes)`, 'debug');
      if (fullPathBytes <= MAX_PATH_BYTES) {
        return { path: fullPath, truncated: false };
      }
      log(`[Path Check] 경로가 너무 깁니다(Bytes: ${fullPathBytes}): ${fullPath}`);
      const pathParts = fullPath.split(path.sep);
      const driveOrRoot = pathParts[0] || '/';
      const lastElement = pathParts[pathParts.length - 1];
      const isLastElementFile = lastElement.includes('.');
      const fileNameBytes = isLastElementFile ? Buffer.byteLength(lastElement) : 0;
      const rootBytes = Buffer.byteLength(driveOrRoot);
      const separatorBytes = (pathParts.length - 1) * Buffer.byteLength(path.sep);
      const totalDirBytes = MAX_PATH_BYTES - fileNameBytes - rootBytes - separatorBytes;
      const dirCount = isLastElementFile ? pathParts.length - 2 : pathParts.length - 1;
      const avgMaxBytes = Math.max(20, Math.floor(totalDirBytes / (dirCount > 0 ? dirCount : 1)));
      const truncatedParts = [driveOrRoot];
      let bytesUsed = rootBytes + separatorBytes;
      for (let i = 1; i < pathParts.length; i++) {
        let part = pathParts[i];
        const partBytes = Buffer.byteLength(part);
        if (i === pathParts.length - 1 && isLastElementFile) {
          if (partBytes > MAX_FILENAME_BYTES) {
            part = truncateFileName(part);
          }
          truncatedParts.push(part);
          continue;
        }
        if (partBytes > avgMaxBytes) {
          let truncatedPart = '';
          for (let j = 0; j < part.length; j++) {
            const nextChar = part[j];
            const potentialNew = truncatedPart + nextChar;
            if (Buffer.byteLength(potentialNew + '...') <= avgMaxBytes) {
              truncatedPart = potentialNew;
            } else {
              break;
            }
          }
          if (truncatedPart.length === 0 && part.length > 0) {
            truncatedPart = part.substring(0, 1);
          }
          part = truncatedPart + '...';
        }
        truncatedParts.push(part);
        bytesUsed += Buffer.byteLength(part) + Buffer.byteLength(path.sep);
      }
      const truncatedPath = truncatedParts.join(path.sep);
      const finalPathBytes = Buffer.byteLength(truncatedPath);
      log(`[Path Check] 경로 길이 제한 결과: '${truncatedPath}' (${finalPathBytes} bytes)`, 'debug');
      if (finalPathBytes > MAX_PATH_BYTES) {
        const rootAndFile = isLastElementFile ? 
          [driveOrRoot, truncateFileName(lastElement)] : 
          [driveOrRoot, truncatedParts[truncatedParts.length - 1]];
        const emergencyPath = rootAndFile.join(path.sep + '...' + path.sep);
        log(`[Path Check] 비상 경로 축소: ${truncatedPath} → ${emergencyPath}`);
        return { path: emergencyPath, truncated: true, emergency: true };
      }
      return { path: truncatedPath, truncated: true };
    }

    // 4. 파일 처리 루프 (내부 비동기화 및 병렬 처리 제한)
    const CONCURRENCY_LIMIT = 100; // *** 동시 처리 개수 제한 설정 ***
    const limit = pLimit(CONCURRENCY_LIMIT);

    const uploadPromises = fileInfoArray.map((fileInfo) => {
      // *** 각 비동기 작업을 limit으로 감싸기 ***
      return limit(async () => {
        logWithIP(`[Upload Loop] 처리 시작: ${fileInfo.originalName}, 상대 경로: ${fileInfo.relativePath}`, req, 'debug');
        
        const expectedFieldName = `file_${fileInfo.index}`;
        const uploadedFile = req.files.find(f => f.fieldname === expectedFieldName);

        if (!uploadedFile) {
          const errorMessage = `[Upload Loop] 업로드된 파일 객체를 찾을 수 없음: ${expectedFieldName} (원본명: ${fileInfo.originalName})`;
          errorLogWithIP(errorMessage, null, req);
          return { 
            originalName: fileInfo.originalName, 
            status: 'error', 
            message: '서버에서 해당 파일 데이터를 찾을 수 없습니다.',
            errorDetail: errorMessage
          }; 
        }
        
        logWithIP(`[Upload Loop] 파일 발견: ${uploadedFile.filename} (원본: ${fileInfo.originalName})`, req, 'debug');

        // 대상 경로 및 파일명 결정
        // 문제 수정: relativePath에서 파일명과 디렉토리 경로 분리
        let relativeDirPath = '';
        if (fileInfo.relativePath) {
          // relativePath에 파일명이 포함된 경우 분리
          if (fileInfo.relativePath.includes(fileInfo.originalName)) {
            relativeDirPath = fileInfo.relativePath.replace(fileInfo.originalName, '');
            // 끝에 슬래시가 있으면 제거
            relativeDirPath = relativeDirPath.replace(/[\/\\]$/, '');
            logWithIP(`[Upload Loop] relativePath에서 파일명 분리: 경로=${relativeDirPath}, 파일명=${fileInfo.originalName}`, req, 'debug');
          } else {
            // 파일명이 포함되지 않은 경우 그대로 사용
            relativeDirPath = fileInfo.relativePath;
          }
        }

        const targetDirPath = path.join(rootUploadDir, relativeDirPath);
        const finalFileName = truncateFileName(fileInfo.originalName); // 파일명 길이 제한 적용
        let targetFilePath = path.join(targetDirPath, finalFileName);

        logWithIP(`[Upload Loop] 대상 경로 계산 (변경 전): ${targetFilePath}`, req, 'debug'); // !!!! 로깅 추가 !!!!
        
        // 경로 길이 확인 및 제한
        const pathCheckResult = checkAndTruncatePath(targetFilePath);
        if (pathCheckResult.truncated) {
            targetFilePath = pathCheckResult.path;
            logWithIP(`[Upload Loop] 경로 길이 제한 적용됨: ${targetFilePath}`, req, 'info');
            if (pathCheckResult.emergency) {
                logWithIP(`[Upload Loop] 경로 길이 비상 축소 적용됨: ${targetFilePath}`, req, 'warning');
            }
        }
        logWithIP(`[Upload Loop] 대상 경로 계산 (변경 후): ${targetFilePath}`, req, 'debug'); // !!!! 로깅 추가 !!!!
        
        try {
          // 최종 대상 디렉토리 (파일명 제외)
          const finalTargetDir = path.dirname(targetFilePath);

          // 대상 디렉토리 존재 확인, 없으면 생성
          try {
            // fs.promises.stat으로 확인하는 대신, 그냥 mkdir 시도 (recursive: true는 오류 없이 처리)
            // await fs.promises.mkdir(finalTargetDir, { recursive: true });
            // logWithIP(`[Upload Loop] 대상 디렉토리 생성/확인 완료: ${finalTargetDir}`, req, 'debug');
            
            // 전역 함수 escapeShellArg 사용 (중복 정의 제거)
            
            // mkdir 명령어 실행 (-p: 상위 디렉토리 자동 생성, -m 777: 권한 설정)
            const escapedTargetDir = escapeShellArg(finalTargetDir);
            const mkdirCommand = `mkdir -p -m 777 ${escapedTargetDir}`;
            logWithIP(`[Upload Loop] mkdir 명령어 실행: ${mkdirCommand}`, req, 'debug');
            
            // util.promisify로 exec를 프로미스로 변환
            const { promisify } = require('util');
            const execPromise = promisify(require('child_process').exec);
            
            const { stdout, stderr } = await execPromise(mkdirCommand);
            if (stderr) {
              logWithIP(`[Upload Loop] mkdir stderr (정보): ${stderr.trim()}`, req, 'debug');
            }
            logWithIP(`[Upload Loop] 대상 디렉토리 생성/확인 완료: ${finalTargetDir}`, req, 'debug');
          } catch (mkdirError) {
            // mkdir 명령어 실행 실패 시 오류 로깅 및 전파
            errorLogWithIP(`[Upload Loop] 대상 디렉토리 생성 명령어 오류: ${finalTargetDir}`, mkdirError, req);
            if (mkdirError.stderr) {
              errorLogWithIP(`[Upload Loop] mkdir stderr: ${mkdirError.stderr}`, null, req);
            }
            throw mkdirError;
          }

          // *** 파일 이동 시도 (rename 우선, EXDEV 시 copy+unlink) ***
          try {
            // 1. rename 시도
            await fs.promises.rename(uploadedFile.path, targetFilePath);
            logWithIP(`[Upload Loop] 파일 이동(rename) 완료: ${uploadedFile.path} -> ${targetFilePath}`, req, 'debug');
          } catch (renameError) {
            // 2. rename 실패 시
            if (renameError.code === 'EXDEV') {
              // EXDEV 오류: 다른 파일 시스템 간 이동 시도 -> 복사+삭제로 대체
              logWithIP(`[Upload Loop] rename 실패 (EXDEV), copy+unlink로 대체: ${uploadedFile.path} -> ${targetFilePath}`, req, 'warn');
              await fs.promises.copyFile(uploadedFile.path, targetFilePath);
              await fs.promises.unlink(uploadedFile.path); 
              logWithIP(`[Upload Loop] 파일 복사+삭제 완료: ${targetFilePath}`, req, 'debug');
            } else {
              // EXDEV 외 다른 rename 오류는 상위 catch로 전파
              throw renameError;
            }
          }
          // *** 파일 이동/복사 후에는 임시 파일이 없으므로 unlink 호출 제거 ***
          // await fs.promises.unlink(uploadedFile.path);
          // logWithIP(`[Upload Loop] 임시 파일 삭제 완료: ${uploadedFile.path}`, req, 'debug');

          // 성공 결과 반환
          return {
            originalName: fileInfo.originalName,
            newName: finalFileName, // 길이 제한 적용된 이름
            relativePath: fileInfo.relativePath,
            newPath: targetFilePath, // 길이 제한 적용된 전체 경로
            status: 'success',
            truncated: pathCheckResult.truncated,
            isFolder: false  // 업로드된 파일은 항상 폴더가 아닙니다
          };
        } catch (writeError) {
          const errorMessage = `[Upload Loop] 파일 처리 오류 (${fileInfo.originalName}): ${writeError.message}`;
          errorLogWithIP(errorMessage, writeError, req);
          // 오류 발생 시에도 임시 파일 삭제 시도 (오류 무시, rename 실패 후 copy실패 등)
          fs.promises.unlink(uploadedFile.path).catch(unlinkErr => {
              if (unlinkErr.code !== 'ENOENT') { // 파일이 이미 없는 경우는 무시
                  errorLogWithIP(`[Upload Loop] 오류 후 임시 파일 삭제 실패 (${uploadedFile.path})`, unlinkErr, req);
              }
          });
          return {
            originalName: fileInfo.originalName,
            status: 'error',
            message: '파일 저장 중 오류가 발생했습니다.',
            errorDetail: errorMessage
          };
        }
      }); // limit(async () => ...) 끝
    }); // fileInfoArray.map 끝

    // 모든 파일 처리 Promise가 완료될 때까지 기다림 (동시 실행은 제한됨)
    const results = await Promise.all(uploadPromises);
    logWithIP(`[Upload End] 모든 파일 처리 완료 (${results.length}개)`, req, 'info');

    // 5. 임시 요청 디렉토리 정리 (이전 상태로 복구)
    if (req.uniqueTmpDir) {
      try {
        await fs.promises.rm(req.uniqueTmpDir, { recursive: true, force: true });
        logWithIP(`[Upload Cleanup] 임시 요청 디렉토리 삭제 완료: ${req.uniqueTmpDir}`, req, 'debug');
      } catch (cleanupError) {
        errorLogWithIP(`[Upload Cleanup] 임시 요청 디렉토리 삭제 실패: ${req.uniqueTmpDir}`, cleanupError, req);
      }
    }

    // 6. 결과 집계 및 응답 (이전 상태로 복구)
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.length - successCount;
    const errorsDetails = results.filter(r => r.status === 'error');

    logWithIP(`[Upload Result] 성공: ${successCount}, 실패: ${errorCount}`, req, 'info'); // 레벨 변경: minimal -> info
    // === 추가: 상세 처리 결과 로그 (info 레벨) ===
    logWithIP(`[Upload Details] 처리 결과: ${JSON.stringify(results, null, 2)}`, req, 'info');

    if (errorCount > 0) {
      res.status(207).json({ // 207 Multi-Status 사용
        message: `파일 업로드 완료 (${successCount}개 성공, ${errorCount}개 실패)`,
        processedFiles: results, // 각 파일별 상세 결과 포함
        errors: errorsDetails
      });
    } else {
      res.status(200).json({ 
        message: '모든 파일이 성공적으로 업로드되었습니다.',
        processedFiles: results // 성공 시에도 상세 결과 제공
      });
    }

  } catch (error) {
    // *** 전체 핸들러의 예외 처리 (기존 유지) ***
    errorLogWithIP('파일 업로드 API 처리 중 예외 발생:', error, req);
    // 오류 발생 시에도 임시 요청 디렉토리 삭제 시도
    if (req.uniqueTmpDir) {
        fs.promises.rm(req.uniqueTmpDir, { recursive: true, force: true }).catch(cleanupError => {
            errorLogWithIP('[Upload Error Cleanup] 오류 발생 후 임시 요청 디렉토리 삭제 실패', cleanupError, req);
        });
    }
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.', details: error.message });
  }
});

// 바이트 단위를 읽기 쉬운 형식으로 변환하는 함수
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// 유틸리티 함수
function getFileIconClass(filename) {
  const ext = path.extname(filename).toLowerCase();
  
  // 파일 확장자별 아이콘 클래스
  const iconMap = {
    '.pdf': 'far fa-file-pdf',
    '.doc': 'far fa-file-word',
    '.docx': 'far fa-file-word',
    '.xls': 'far fa-file-excel',
    '.xlsx': 'far fa-file-excel',
    '.ppt': 'far fa-file-powerpoint',
    '.pptx': 'far fa-file-powerpoint',
    '.jpg': 'far fa-file-image',
    '.jpeg': 'far fa-file-image',
    '.png': 'far fa-file-image',
    '.gif': 'far fa-file-image',
    '.txt': 'far fa-file-alt',
    '.zip': 'far fa-file-archive',
    '.rar': 'far fa-file-archive',
    '.mp3': 'far fa-file-audio',
    '.wav': 'far fa-file-audio',
    '.mp4': 'far fa-file-video',
    '.mov': 'far fa-file-video',
    '.js': 'far fa-file-code',
    '.html': 'far fa-file-code',
    '.css': 'far fa-file-code',
    '.json': 'far fa-file-code',
  };

  return iconMap[ext] || 'far fa-file';
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + units[i];
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
}

// WebDAV 서버 구성
app.use('/webdav', webdav.extensions.express('/webdav', server));

// 디스크 사용량 확인 API
app.get('/api/disk-usage', async (req, res) => { // *** async 추가 ***
  try {
    // *** await 추가 ***
    const diskUsage = await getDiskUsage(); 
    // 로그 메시지에는 formatBytes 적용된 값이 들어가므로 이전 로그는 제거하거나 debug 레벨로 변경 고려
    // log(`디스크 사용량 조회: ${formatFileSize(diskUsage.used)} / ${formatFileSize(diskUsage.total)} (${diskUsage.percent}%)`, 'info'); // 일단 주석 처리
    res.json(diskUsage); // 실제 결과 객체 반환
  } catch (error) {
    errorLog('디스크 사용량 조회 API 오류:', error); // 오류 로그 메시지 명확화
    res.status(500).json({
      error: '디스크 사용량 조회 중 오류가 발생했습니다.'
    });
  }
});

// 파일 압축 API (비동기화)
app.post('/api/compress', bodyParser.json(), async (req, res) => { // *** async 추가 ***
  try {
    const { files, targetPath, zipName } = req.body;
    
    logWithIP(`[Compress Request] ${files.length}개 파일 '${zipName}'으로 압축 요청 (${targetPath || '루트'})`, req, 'info'); // 레벨 변경: minimal -> info

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '압축할 파일이 선택되지 않았습니다.' });
    }
    
    if (!zipName) {
      return res.status(400).json({ error: '압축 파일 이름이 필요합니다.' });
    }
    
    log(`압축 요청: ${files.length}개 파일, 대상 경로: ${targetPath || '루트'}, 압축파일명: ${zipName}`, 'info');
    
    const basePath = targetPath ? path.join(ROOT_DIRECTORY, targetPath) : ROOT_DIRECTORY;
    const zipFilePath = path.join(basePath, zipName.endsWith('.zip') ? zipName : `${zipName}.zip`);
    
    // *** 중복 확인 (비동기) ***
    try {
      await fs.promises.access(zipFilePath);
      // 파일이 존재하면 409 Conflict 반환
      return res.status(409).json({ error: '같은 이름의 압축 파일이 이미 존재합니다.' });
    } catch (error) {
      if (error.code !== 'ENOENT') { 
        // 접근 오류 외 다른 오류는 로깅 후 500 반환
        errorLog('압축 파일 존재 확인 오류:', error);
        return res.status(500).json({ error: '서버 오류가 발생했습니다.', message: error.message });
      }
      // ENOENT 오류는 파일이 없다는 의미이므로 정상 진행
    }
    
    // archiver를 사용한 압축 구현
    // 압축 파일 스트림 생성
    const output = fs_stream.createWriteStream(zipFilePath);
    const archive = archiver('zip', {
      zlib: { level: 0 } // 압축률 (0: 저장만 하기, 9: 최대 압축)
    });
    
    // 압축 스트림 이벤트 설정
    output.on('close', async () => {
      try {
        // 압축 파일 권한 설정
        await fs.promises.chmod(zipFilePath, 0o666);
        
        log(`압축 완료: ${zipFilePath} (크기: ${archive.pointer()} bytes)`, 'info');
        res.status(200).json({ 
          success: true, 
          message: '압축이 완료되었습니다.',
          zipFile: path.basename(zipFilePath),
          zipPath: targetPath || ''
        });
      } catch (error) {
        errorLog('압축 완료 후 처리 오류:', error);
        // 이미 스트림이 닫힌 후이므로 응답은 보낼 수 없음
      }
    });
    
    archive.on('error', (error) => {
      errorLog('압축 중 오류 발생:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: '파일 압축 중 오류가 발생했습니다.', message: error.message });
      }
    });
    
    // 압축 스트림을 출력 스트림에 연결
    archive.pipe(output);
    
    // 파일 추가
    let validFilesCount = 0;
    for (const file of files) {
      const filePath = targetPath ? `${targetPath}/${file}` : file;
      const fullPath = path.join(ROOT_DIRECTORY, filePath);
      
      try {
        const stats = await fs.promises.stat(fullPath);
        if (stats.isDirectory()) {
          // 폴더인 경우 하위 모든 파일 포함
          archive.directory(fullPath, file);
        } else {
          // 파일인 경우 직접 추가
          archive.file(fullPath, { name: file });
        }
        validFilesCount++;
      } catch (error) {
        log(`압축 대상 접근 오류 (무시됨): ${fullPath}`, 'debug');
        // 개별 파일 오류는 전체 압축을 중단하지 않고 무시
      }
    }
    
    if (validFilesCount === 0) {
      archive.abort(); // 스트림 중단
      return res.status(400).json({ error: '압축할 유효한 파일/폴더가 없습니다.' });
    }
    
    // 압축 시작
    await archive.finalize();
    
  } catch (error) {
    errorLog('압축 API 오류:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '파일 압축 중 오류가 발생했습니다.', message: error.message });
    }
  }
});

// 폴더 잠금 상태 조회 API (비동기화)
app.get('/api/lock-status', async (req, res) => { // *** async 추가 ***
  try {
    const lockedFoldersPath = path.join(__dirname, 'lockedFolders.json');
    let lockState = [];
    
    // *** 파일 존재 확인 및 읽기 (비동기) ***
    try {
      const fileContent = await fs.promises.readFile(lockedFoldersPath, 'utf8');
      lockState = JSON.parse(fileContent).lockState || [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 파일이 없으면 빈 배열로 초기화하고 파일 생성 (비동기)
        log('lockedFolders.json 파일 없음. 새로 생성합니다.', 'info');
        try {
          await fs.promises.writeFile(lockedFoldersPath, JSON.stringify({ lockState: [] }), 'utf8');
        } catch (writeError) {
          errorLog('lockedFolders.json 파일 생성 오류:', writeError);
          // 파일 생성 실패 시에도 빈 배열로 응답
        }
      } else {
        // 파싱 오류 또는 기타 읽기 오류
        errorLog('잠긴 폴더 목록 읽기/파싱 오류:', error);
        // 오류 발생 시에도 일단 빈 배열로 응답 (클라이언트 오류 방지)
      }
    }
    
    log(`잠금 상태 조회 완료: ${lockState.length}개 폴더 잠김`, 'info');
    res.status(200).json({ lockState });

  } catch (error) {
    // 핸들러 자체의 예외 처리
    errorLog('잠금 상태 조회 API 오류:', error);
    res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// 폴더 잠금/해제 API (비동기화)
app.post('/api/lock/:path(*)', express.json(), async (req, res) => { // *** async 추가, express.json() 미들웨어 추가 ***
  try {
    const folderPath = decodeURIComponent(req.params.path || '');
    const action = req.body.action || 'lock'; // 'lock' 또는 'unlock'
    const fullPath = path.join(ROOT_DIRECTORY, folderPath);
    
    logWithIP(`[Lock Request] '${folderPath}' ${action === 'lock' ? '잠금' : '잠금 해제'} 요청`, req, 'info'); // 레벨 변경: minimal -> info
    log(`폴더 ${action === 'lock' ? '잠금' : '잠금 해제'} 요청: ${fullPath}`, 'info');

    let stats;
    // *** 폴더 존재 및 정보 확인 (비동기) ***
    try {
      stats = await fs.promises.stat(fullPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        errorLogWithIP(`폴더를 찾을 수 없음: ${fullPath}`, null, req);
        return res.status(404).send('폴더를 찾을 수 없습니다.');
      } else {
        errorLogWithIP(`폴더 정보 확인 오류: ${fullPath}`, error, req);
        return res.status(500).send('서버 오류가 발생했습니다.');
      }
    }

    // 디렉토리인지 확인
    if (!stats.isDirectory()) {
      errorLogWithIP(`잠금 대상이 폴더가 아님: ${fullPath}`);
      return res.status(400).send('폴더만 잠금/해제할 수 있습니다.');
    }

    // lockedFolders.json 파일 로드 (비동기)
    const lockedFoldersPath = path.join(__dirname, 'lockedFolders.json');
    let lockedFolders = { lockState: [] }; // 기본값
    try {
      const fileContent = await fs.promises.readFile(lockedFoldersPath, 'utf8');
      lockedFolders = JSON.parse(fileContent);
      if (!lockedFolders.lockState) {
        lockedFolders.lockState = [];
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        log('lockedFolders.json 파일 없음. 새로 생성합니다.', 'info');
        // 파일 없으면 기본값 사용 (저장 시 파일 생성됨)
      } else {
        errorLog('잠긴 폴더 목록 읽기/파싱 오류:', error);
        // 읽기/파싱 오류 시에도 일단 기본값으로 진행하나, 저장은 시도
      }
    }

    // 잠금 또는 해제 처리
    let changed = false;
    if (action === 'lock') {
      if (!lockedFolders.lockState.includes(folderPath)) {
        const isParentLocked = lockedFolders.lockState.some(lockedPath => 
          folderPath.startsWith(lockedPath + '/'));
        
        if (isParentLocked) {
          log(`상위 폴더가 이미 잠겨 있어 ${folderPath} 폴더는 잠그지 않습니다.`, 'info');
          // 상태 변경 없이 성공 응답 (클라이언트 혼란 방지)
          return res.status(200).json({
            success: true,
            message: "상위 폴더가 이미 잠겨 있습니다.",
            path: folderPath,
            action: action,
            status: 'skipped'
          });
        }
        
        const subLockedFolders = lockedFolders.lockState.filter(lockedPath => 
          lockedPath.startsWith(folderPath + '/'));
        
        if (subLockedFolders.length > 0) {
          log(`${folderPath} 폴더 잠금으로 인해 ${subLockedFolders.length}개의 하위 폴더 잠금이 해제됩니다.`, 'info');
          lockedFolders.lockState = lockedFolders.lockState.filter(path => 
            !path.startsWith(folderPath + '/'));
        }
        
        lockedFolders.lockState.push(folderPath);
        changed = true;
        log(`폴더 잠금 적용: ${folderPath}`, 'info');
      } else {
        log(`폴더가 이미 잠겨 있음: ${folderPath}`, 'info');
      }
    } else { // action === 'unlock'
      const initialLength = lockedFolders.lockState.length;
      lockedFolders.lockState = lockedFolders.lockState.filter(path => path !== folderPath);
      if (lockedFolders.lockState.length < initialLength) {
        changed = true;
        log(`폴더 잠금 해제 적용: ${folderPath}`, 'info');
      } else {
        log(`폴더가 잠겨있지 않음: ${folderPath}`, 'info');
      }
    }

    // 변경 사항이 있을 경우 파일 저장 (비동기)
    if (changed) {
      try {
        await fs.promises.writeFile(lockedFoldersPath, JSON.stringify(lockedFolders, null, 2), 'utf8');
        await fs.promises.chmod(lockedFoldersPath, 0o666);
        log('잠긴 폴더 목록 저장 완료.', 'info');
      } catch (writeError) {
        errorLog('잠긴 폴더 목록 저장 오류:', writeError);
        // 파일 저장 실패 시 오류 응답
        return res.status(500).send('잠금 상태 저장 중 오류가 발생했습니다.');
      }
    }

    // 성공 응답
    res.status(200).json({
      success: true,
      message: `폴더가 성공적으로 ${action === 'lock' ? '잠금' : '잠금 해제'}되었습니다.`, 
      path: folderPath,
      action: action,
      status: changed ? 'updated' : 'nochange'
    });

  } catch (error) {
    // 핸들러 자체의 예외 처리
    errorLog('폴더 잠금/해제 API 오류:', error);
    res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// 파일 목록 조회 또는 파일 다운로드
app.get('/api/files/*', async (req, res) => {
  try {
    // URL 디코딩하여 한글 경로 처리
    let requestPath = decodeURIComponent(req.params[0] || '');
    const fullPath = path.join(ROOT_DIRECTORY, requestPath);
    
    logWithIP(`파일 목록/다운로드 요청: ${fullPath}`, req, 'info');

    let stats;
    try {
      // *** 비동기 방식으로 경로 존재 및 정보 확인 ***
      stats = await fs.promises.stat(fullPath);
    } catch (error) {
      // 존재하지 않는 경우 404
      if (error.code === 'ENOENT') {
        errorLogWithIP(`경로를 찾을 수 없습니다: ${fullPath}`, null, req);
        return res.status(404).send('경로를 찾을 수 없습니다.');
      } else {
        // 기타 stat 오류
        errorLogWithIP(`파일/디렉토리 정보 확인 오류: ${fullPath}`, error, req);
        return res.status(500).send('서버 오류가 발생했습니다.');
      }
    }

    // 디렉토리인지 확인
    if (!stats.isDirectory()) {
      // 파일인 경우 처리 (기존 다운로드 로직 유지)
      logWithIP(`파일 다운로드 요청: ${fullPath}`, req, 'info');
      
      // 파일명 추출
      const fileName = path.basename(fullPath);
      // 파일 확장자 추출
      const fileExt = path.extname(fullPath).toLowerCase().substring(1);
      
      // 브라우저에서 직접 볼 수 있는 파일 형식
      const viewableTypes = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 
                            'mp4', 'webm', 'ogg', 'mp3', 'wav', 
                            'pdf', 'txt', 'html', 'htm', 'css', 'js', 'json', 'xml'];
      
      // MIME 타입 설정
      const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'ogg': 'video/ogg',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'pdf': 'application/pdf',
        'txt': 'text/plain',
        'html': 'text/html',
        'htm': 'text/html',
        'css': 'text/css',
        'js': 'text/javascript',
        'json': 'application/json',
        'xml': 'application/xml'
      };
      
      // 직접 볼 수 있는 파일인지 확인
      if (viewableTypes.includes(fileExt)) {
        res.setHeader('Content-Type', mimeTypes[fileExt] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        fs.createReadStream(fullPath).pipe(res); // 스트림 방식은 비동기
      } else {
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.download(fullPath, fileName, (err) => { // res.download도 비동기 처리
          if (err) {
            errorLogWithIP(`파일 다운로드 중 오류: ${fullPath}`, err, req);
          } else {
            logWithIP(`파일 다운로드 완료: ${fullPath}`, req, 'info');
          }
        });
      }
      return;
    }

    // 디렉토리 내용 읽기 (비동기)
    const items = await fs.promises.readdir(fullPath);
    
    // 각 항목의 정보를 비동기적으로 가져오기 (Promise.all 사용)
    const fileItemsPromises = items.map(async (item) => {
      const itemPath = path.join(fullPath, item);
      try {
        const itemStats = await fs.promises.stat(itemPath);
        const isDirectory = itemStats.isDirectory();
        return {
          name: item,
          isFolder: isDirectory,
          size: itemStats.size,
          modifiedTime: itemStats.mtime.toISOString()
        };
      } catch (itemError) {
        // 개별 항목 stat 오류 처리 (예: 권한 문제)
        errorLogWithIP(`항목 정보 확인 오류: ${itemPath}`, itemError, req);
        return null; // 오류 발생 시 null 반환 또는 다른 방식으로 처리
      }
    });

    // 모든 Promise가 완료될 때까지 기다린 후, null이 아닌 항목만 필터링
    const fileItems = (await Promise.all(fileItemsPromises)).filter(item => item !== null);

    logWithIP(`파일 목록 반환: ${fileItems.length}개 항목`, req, 'info');
    res.json(fileItems);

  } catch (error) {
    // 핸들러 전체의 오류 처리
    errorLogWithIP('파일 목록 API 오류:', error, req);
    res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// 새 폴더 생성 라우터 (직접 생성 방식)
app.post('/api/files/:folderPath(*)', async (req, res) => {
  const folderPathRaw = req.params.folderPath;
  logWithIP(`새 폴더 생성 요청 수신 - Raw Path: ${folderPathRaw}`, req, 'info');

  if (!folderPathRaw) {
    errorLogWithIP('새 폴더 생성 오류: 경로가 비어있음', null, req);
    return res.status(400).json({ success: false, message: '폴더 경로가 필요합니다.' });
  }

  let decodedPath;
  try {
    // 경로 디코딩
    decodedPath = decodeURIComponent(folderPathRaw);
    logWithIP(`Decoded Path: ${decodedPath}`, req);
  } catch (e) {
    errorLogWithIP('새 폴더 생성 오류: 경로 디코딩 실패', e, req);
    return res.status(400).json({ success: false, message: '잘못된 경로 형식입니다.' });
  }

  // 경로 정제 및 최종 경로 생성
  const sanitizedPath = decodedPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const targetFullPath = path.join(ROOT_DIRECTORY, sanitizedPath);
  logWithIP(`Target Full Path: ${targetFullPath}`, req);

  // 보안 검사 (루트 경로 탈출 방지)
  if (!targetFullPath.startsWith(ROOT_DIRECTORY + path.sep) && targetFullPath !== ROOT_DIRECTORY) {
    errorLogWithIP('새 폴더 생성 오류: 허용되지 않은 경로 접근 시도', { requestedPath: sanitizedPath, resolvedPath: targetFullPath }, req);
    return res.status(403).json({ success: false, message: '허용되지 않은 경로입니다.' });
  }

  // 폴더명 유효성 검사
  const folderName = path.basename(sanitizedPath);
  if (/[\\/:*?"<>|]/.test(folderName)) {
      errorLogWithIP('새 폴더 생성 오류: 유효하지 않은 폴더 이름', { folderName: folderName }, req);
      return res.status(400).json({ success: false, message: '폴더 이름에 사용할 수 없는 문자가 포함되어 있습니다.' });
  }

  // 경로 길이 검사
  if (Buffer.byteLength(targetFullPath, 'utf8') > MAX_PATH_BYTES) {
    errorLogWithIP('새 폴더 생성 오류: 경로가 너무 김', { path: targetFullPath }, req);
    return res.status(400).json({ success: false, message: `경로가 너무 깁니다. (최대 ${MAX_PATH_BYTES} 바이트)` });
  }

  // 잠금 상태 확인
  if (isPathAccessRestricted(sanitizedPath)) {
      errorLogWithIP('새 폴더 생성 오류: 대상 폴더 또는 상위 폴더 잠김', { path: sanitizedPath }, req);
      return res.status(403).json({ success: false, message: '대상 폴더 또는 상위 폴더가 잠겨 있어 생성할 수 없습니다.' });
  }

  // 직접 폴더 생성 시도
  try {
    // 디렉토리 생성
    // await fs.promises.mkdir(targetFullPath, { recursive: true, mode: 0o777 });
    
    // 특수문자를 완벽하게 이스케이프하는 함수
    
    const escapedPath = escapeShellArg(targetFullPath);
    const mkdirCommand = `mkdir -p -m 777 ${escapedPath}`;
    logWithIP(`새 폴더 생성 명령어 실행: ${mkdirCommand}`, req, 'debug');
    
    // util.promisify로 exec를 프로미스로 변환 (함수 외부에서 선언된 경우 재사용)
    const { promisify } = require('util');
    const execPromise = promisify(require('child_process').exec);
    
    const { stdout, stderr } = await execPromise(mkdirCommand);
    if (stderr) {
      logWithIP(`mkdir stderr (정보): ${stderr.trim()}`, req, 'debug');
    }
    
    logWithIP(`폴더 생성 완료: ${targetFullPath}`, req, 'minimal');
    return res.status(201).json({ success: true, message: '폴더가 생성되었습니다.' });
  } catch (error) {
    errorLogWithIP(`폴더 생성 실패: ${targetFullPath}`, error, req);
    if (error.code === 'EACCES') {
         res.status(403).json({ success: false, message: '폴더 생성 권한이 없습니다.' });
    } else if (error.code === 'EEXIST') {
         // recursive: true 옵션으로 인해 이 코드는 일반적으로 발생하지 않지만, 만약을 위해 처리
         logWithIP(`폴더 생성 시도 중 이미 존재: ${targetFullPath}`, req, 'info'); // 이미 존재하는 경우 성공으로 간주할 수도 있음
         res.status(409).json({ success: false, message: '이미 존재하는 이름입니다.' }); // 또는 성공 처리
    }
     else {
         res.status(500).json({ success: false, message: '폴더 생성 중 오류가 발생했습니다.' });
    }
  }
});

// 파일/폴더 이름 변경 또는 이동 (시스템 명령어로 재수정)
app.put('/api/files/*', express.json(), async (req, res) => {
  try {
    const oldPathRelative = decodeURIComponent(req.params[0] || '');
    const { newName, targetPath, overwrite } = req.body;

    logWithIP(`[Move/Rename Request - CMD] '${oldPathRelative}' -> '${newName}' (대상: ${targetPath !== undefined ? targetPath : '동일 경로'})`, req, 'info'); // 레벨 변경: minimal -> info

    if (!newName) {
      errorLogWithIP('새 이름이 제공되지 않음', null, req);
      return res.status(400).send('새 이름이 제공되지 않았습니다.');
    }

    const fullOldPath = path.join(ROOT_DIRECTORY, oldPathRelative);
    const escapedFullOldPath = escapeShellArg(fullOldPath);

    // 원본 존재 확인 (fs.promises.access 유지 - stat으로 변경해도 무방)
    try {
      await fs.promises.access(fullOldPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        errorLogWithIP(`원본 파일/폴더를 찾을 수 없음: ${fullOldPath}`, null, req);
        return res.status(404).send(`파일 또는 폴더를 찾을 수 없습니다: ${oldPathRelative}`);
      } else {
        errorLogWithIP(`원본 접근 오류: ${fullOldPath}`, error, req);
        return res.status(500).send('서버 오류가 발생했습니다.');
      }
    }

    // 잠금 확인 로직 (기존과 동일)
    if (isPathAccessRestricted(oldPathRelative)) {
        errorLogWithIP(`잠긴 항목 이동/이름 변경 시도: ${fullOldPath}`, null, req);
        return res.status(403).send('잠긴 폴더 또는 그 하위 항목은 이동하거나 이름을 변경할 수 없습니다.');
    }

    // 대상 경로 설정
    const targetDirRelative = targetPath !== undefined ? targetPath : path.dirname(oldPathRelative);
    const fullTargetPath = path.join(ROOT_DIRECTORY, targetDirRelative);
    const fullNewPath = path.join(fullTargetPath, newName);
    const escapedFullTargetPath = escapeShellArg(fullTargetPath);
    const escapedFullNewPath = escapeShellArg(fullNewPath);

    logWithIP(`전체 경로 처리 (CMD): ${fullOldPath} -> ${fullNewPath}`, req, 'debug');

    // 원본과 대상이 같은 경우
    if (fullOldPath === fullNewPath) {
      logWithIP(`동일한 경로로의 이동/변경 무시: ${fullOldPath}`, req, 'debug');
      return res.status(200).send('이름 변경/이동이 완료되었습니다.');
    }

    // 대상 경로 잠금 확인 (기존과 동일)
    if (isPathAccessRestricted(path.join(targetDirRelative, newName))) {
        errorLogWithIP(`잠긴 폴더 내부 또는 잠긴 이름으로 이동/변경 시도: ${fullNewPath}`, null, req);
        return res.status(403).send('잠긴 폴더 내부로 이동하거나 잠긴 이름으로 변경할 수 없습니다.');
    }

    // 대상 디렉토리 생성 (mkdir -p)
    try {
      const mkdirCommand = `mkdir -p ${escapedFullTargetPath}`;
      logWithIP(`대상 디렉토리 생성 명령어 실행: ${mkdirCommand}`, req, 'debug');
      const { stdout: mkdirStdout, stderr: mkdirStderr } = await exec(mkdirCommand);
      if (mkdirStderr) {
        // Optional chaining 추가
        logWithIP(`mkdir stderr (정보): ${mkdirStderr?.trim()}`, req, 'debug'); // mkdir -p는 존재해도 오류 아님
      }
      logWithIP(`대상 디렉토리 확인/생성 완료: ${fullTargetPath}`, req, 'debug');
    } catch (mkdirError) {
      errorLogWithIP(`대상 디렉토리 생성 명령어 오류: ${fullTargetPath}`, mkdirError, req);
      if (mkdirError.stderr) {
        // Optional chaining 추가
        errorLogWithIP(`mkdir stderr: ${mkdirError?.stderr}`, null, req);
      }
      return res.status(500).send('대상 폴더 생성 중 오류가 발생했습니다.');
    }

    // 대상 경로에 이미 존재하는 경우 처리
    try {
      // 존재 여부 확인 (fs.promises.access 또는 stat 유지)
      await fs.promises.access(fullNewPath);

      // 존재하면 덮어쓰기 옵션 확인
      if (!overwrite) {
        errorLogWithIP(`대상 경로에 파일/폴더가 이미 존재함 (덮어쓰기 비활성): ${fullNewPath}`, null, req);
        return res.status(409).send('같은 이름의 파일이나 폴더가 이미 대상 경로에 존재합니다.');
      }

      // 덮어쓰기 실행 - 기존 항목 삭제 (rm -rf)
      logWithIP(`대상 경로에 존재하는 항목 덮어쓰기 시도 (rm 사용): ${fullNewPath}`, req, 'debug');
      const rmCommand = `rm -rf ${escapedFullNewPath}`;
      logWithIP(`기존 항목 삭제 명령어 실행: ${rmCommand}`, req, 'debug');
      try {
        const { stdout: rmStdout, stderr: rmStderr } = await exec(rmCommand);
        if (rmStderr) {
            // Optional chaining 추가
            errorLogWithIP(`rm stderr: ${rmStderr?.trim()}`, null, req);
            // rm -rf 오류는 심각할 수 있으므로 500 반환 고려
            return res.status(500).send('기존 파일/폴더 삭제 중 오류가 발생했습니다.');
        }
        logWithIP(`기존 항목 삭제 완료 (rm 사용): ${fullNewPath}`, req, 'debug');
      } catch (rmError) {
        errorLogWithIP(`기존 항목 삭제 명령어 오류 (덮어쓰기): ${fullNewPath}`, rmError, req);
        if (rmError.stderr) {
          // Optional chaining 추가
          errorLogWithIP(`rm stderr: ${rmError?.stderr}`, null, req);
        }
        return res.status(500).send('기존 파일/폴더 삭제 중 오류가 발생했습니다.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // access/stat 오류 (존재하지 않는 경우가 아님)
        errorLogWithIP(`대상 경로 확인/삭제 준비 중 오류: ${fullNewPath}`, error, req);
        return res.status(500).send('대상 경로 확인 중 오류가 발생했습니다.');
      }
      // ENOENT는 정상 (파일/폴더 없음, 덮어쓰기 필요 없음)
      logWithIP(`대상 경로에 파일 없음. 덮어쓰기 불필요: ${fullNewPath}`, req, 'debug');
    }

    // 최종 이름 변경/이동 실행
    logWithIP(`이름 변경/이동 시작: ${fullOldPath} -> ${fullNewPath}`, req, 'debug');
    try {
      // 특수문자를 더 견고하게 이스케이프하는 함수
      // function escapeShellArg(arg) {
      //   // 모든 특수문자를 처리하기 위해 작은따옴표로 감싸고
      //   // 내부의 작은따옴표, 백틱, 달러 기호 등을 이스케이프
      //   return `'${arg.replace(/'/g, "'\\''")}'`;
      // }

      // 최종 이름 변경/이동 실행 (mv)
      const escapedFullOldPath = escapeShellArg(fullOldPath);
      const escapedFullNewPath = escapeShellArg(fullNewPath);
      const mvCommand = `mv ${escapedFullOldPath} ${escapedFullNewPath}`;
      logWithIP(`이름 변경/이동 명령어 실행: ${mvCommand}`, req, 'debug');
      
      try {
        const { stdout: mvStdout, stderr: mvStderr } = await exec(mvCommand);
        
        // stderr가 유효한 문자열이고 내용이 있는지 확인 후 처리
        if (typeof mvStderr === 'string' && mvStderr.trim().length > 0) {
          const lowerStderr = mvStderr.toLowerCase();
          if (lowerStderr.includes('no such file or directory') || 
              lowerStderr.includes('permission denied')) {
            errorLogWithIP(`mv 명령어 오류 (치명적): ${mvStderr.trim()}`, { command: mvCommand }, req);
            return res.status(500).send('파일/폴더 이동 중 오류가 발생했습니다.');
          } else {
            // 단순 경고는 로그만 남김
            logWithIP(`mv stderr (정보/경고): ${mvStderr.trim()}`, req, 'info');
          }
        }
        
        // stderr가 없거나 비어있으면 성공으로 간주
        logWithIP(`이름 변경/이동 완료 (mv 사용): ${fullOldPath} -> ${fullNewPath}`, req, 'info'); // 레벨 변경: minimal -> info
        res.status(200).send('이름 변경/이동이 완료되었습니다.');
        
        // 디스크 사용량 갱신 (비동기)
        getDiskUsage().catch(err => errorLogWithIP('이동/변경 후 디스크 사용량 갱신 오류', err, req));
        
      } catch (mvError) {
        errorLogWithIP(`이름 변경/이동 명령어 오류: ${mvCommand}`, mvError, req);
        if (mvError.stderr) {
          errorLogWithIP(`mv stderr: ${mvError.stderr}`, null, req);
        }
        res.status(500).send('파일/폴더 이동 또는 이름 변경 중 오류가 발생했습니다.');
      }
    } catch (renameError) {
      // 일반적인 오류 처리
      errorLogWithIP(`이름 변경/이동 오류: ${fullOldPath} -> ${fullNewPath}`, renameError, req);
      
      // 특정 오류 코드에 따른 상세 메시지
      if (renameError.code === 'ENOENT') {
        return res.status(404).send('이동할 파일 또는 폴더를 찾을 수 없습니다.');
      } else if (renameError.code === 'EACCES' || renameError.code === 'EPERM') {
        return res.status(403).send('파일 또는 폴더 이동 권한이 없습니다.');
      } else if (renameError.code === 'EXDEV') {
        // 다른 파일시스템으로 이동 시 EXDEV 오류 발생 - 복사 후 삭제로 처리
        try {
          logWithIP(`다른 파일시스템 간 이동 감지(EXDEV). 복사+삭제로 대체: ${fullOldPath} -> ${fullNewPath}`, req, 'info');
          
          // 대상이 디렉토리인지 확인
          const oldStat = await fs.promises.stat(fullOldPath);
          const isDirectory = oldStat.isDirectory();
          
          // 특수문자를 완벽하게 이스케이프하는 함수는 위에서 정의됨
          const escapedOldPath = escapeShellArg(fullOldPath);
          const escapedNewPath = escapeShellArg(fullNewPath);
          
          // 시스템 명령어로 복사 및 삭제 (디렉토리 또는 파일)
          let cpCommand;
          if (isDirectory) {
            // -r: 디렉토리 재귀 복사, -p: 권한 유지, -f: 덮어쓰기 강제
            cpCommand = `cp -rpf ${escapedOldPath}/. ${escapedNewPath}`;
            // 대상 디렉토리가 없으면 먼저 생성
            try {
              await fs.promises.mkdir(fullNewPath, { recursive: true });
            } catch (mkdirErr) {
              errorLogWithIP(`대상 디렉토리 생성 실패: ${fullNewPath}`, mkdirErr, req);
              throw mkdirErr;
            }
          } else {
            // 파일 복사
            cpCommand = `cp -f ${escapedOldPath} ${escapedNewPath}`;
          }
          
          logWithIP(`복사 명령어 실행: ${cpCommand}`, req, 'debug');
          
          // 복사 실행
          const { stdout: cpStdout, stderr: cpStderr } = await exec(cpCommand);
          if (cpStderr) {
            logWithIP(`cp stderr: ${cpStderr}`, req, 'info');
          }
          
          // 복사 성공했으므로 원본 삭제
          const rmCommand = `rm -rf ${escapedOldPath}`;
          logWithIP(`삭제 명령어 실행: ${rmCommand}`, req, 'debug');
          
          const { stdout: rmStdout, stderr: rmStderr } = await exec(rmCommand);
          if (rmStderr) {
            logWithIP(`rm stderr: ${rmStderr}`, req, 'info');
          }
          
          logWithIP(`이름 변경/이동 완료 (복사+삭제 명령어): ${fullOldPath} -> ${fullNewPath}`, req, 'info'); // 레벨 변경: minimal -> info
          res.status(200).send('이름 변경/이동이 완료되었습니다.');
          
          // 디스크 사용량 갱신 (비동기)
          getDiskUsage().catch(err => errorLogWithIP('이동/변경 후 디스크 사용량 갱신 오류', err, req));
        } catch (execError) {
          errorLogWithIP(`복사+삭제 명령어 실행 실패: ${fullOldPath} -> ${fullNewPath}`, execError, req);
          res.status(500).send('파일 또는 폴더 이동 중 오류가 발생했습니다.');
        }
      } else {
        // 그 외 기타 오류
        res.status(500).send('파일 또는 폴더 이동 중 오류가 발생했습니다.');
      }
    }

  } catch (error) {
    // 핸들러 자체의 예외 처리
    errorLogWithIP('이름 변경/이동 API 오류:', error, req);
    res.status(500).send(`서버 오류가 발생했습니다: ${error.message}`);
  }
});

// 파일/폴더 삭제 (백그라운드 처리 - 이 부분은 변경 없음, 워커에서 rm 사용)
app.delete('/api/files/*', async (req, res) => {
  try {
    const itemPath = decodeURIComponent(req.params[0] || '');
    const fullPath = path.join(ROOT_DIRECTORY, itemPath);

    logWithIP(`[Delete Request] '${itemPath}' 삭제 요청 (백그라운드 처리)`, req, 'info'); // 레벨 변경: minimal -> info (복원)

    // --- 기본 검사 (동기 또는 비동기 유지) ---
    try {
      // 존재 여부만 확인 (타입은 워커에서 처리)
      await fs.promises.access(fullPath, fs.constants.F_OK);

      // --- 백그라운드 작업 시작 ---
      logWithIP(`백그라운드 삭제 작업 시작 요청: ${fullPath}`, req, 'info'); // 레벨 변경: minimal -> info

      const workerScript = path.join(__dirname, 'backgroundWorker.js');
      // === fork 옵션에 env 추가하여 로그 레벨 전달 ===
      const worker = fork(workerScript, ['delete', fullPath], {
        stdio: 'pipe',  // 변경: 워커 출력을 pipe로 연결 (필요시 로깅 가능)
        env: { 
          ...process.env, // 기존 환경 변수 상속
          // Object.keys...: 현재 숫자 레벨 값을 문자열 키(minimal, info, debug)로 변환
          CURRENT_LOG_LEVEL: Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLogLevel) 
        } 
      });
      activeWorkers.add(worker); // 활성 워커 Set에 추가
      log(`[Worker Management] 워커 생성됨 (PID: ${worker.pid}, 작업: delete). 활성 워커 수: ${activeWorkers.size}`, 'debug');

      worker.stdout.on('data', (data) => {
        log(`[Worker Output - delete:${worker.pid}] ${data.toString().trim()}`, 'debug');
      });
      worker.stderr.on('data', (data) => {
        errorLog(`[Worker Error - delete:${worker.pid}] ${data.toString().trim()}`);
      });

      worker.on('error', (err) => {
        errorLogWithIP(`백그라운드 워커 실행 오류 (delete): ${fullPath}`, err, req);
        activeWorkers.delete(worker); // 오류 발생 시 Set에서 제거
        log(`[Worker Management] 워커 오류로 제거 (PID: ${worker.pid}). 활성 워커 수: ${activeWorkers.size}`, 'debug');
      });

      worker.on('exit', (code, signal) => {
        activeWorkers.delete(worker); // 정상/비정상 종료 시 Set에서 제거
        if (signal) {
          log(`[Worker Management] 워커가 신호 ${signal}로 종료됨 (PID: ${worker.pid}). 활성 워커 수: ${activeWorkers.size}`, 'info');
        } else {
          log(`[Worker Management] 워커 종료됨 (PID: ${worker.pid}, 코드: ${code}). 활성 워커 수: ${activeWorkers.size}`, 'debug');
        }
      });
      
      // --- 즉시 응답 (202 Accepted) ---
      res.status(202).send('삭제 작업이 백그라운드에서 시작되었습니다.');

    } catch (error) {
      // 파일/폴더가 없는 경우 등 사전 검사 오류
      if (error.code === 'ENOENT') {
        errorLogWithIP(`삭제 대상 없음 (사전 검사): ${fullPath}`, error, req);
        return res.status(404).send('파일 또는 폴더를 찾을 수 없습니다.');
      }
      // 기타 사전 검사 오류
      errorLogWithIP(`삭제 요청 처리 중 오류 (사전 검사): ${fullPath}`, error, req);
      return res.status(500).send(`서버 오류가 발생했습니다: ${error.message}`);
    }
    // --- 기본 검사 종료 ---

  } catch (error) {
    // 핸들러 자체의 오류 처리
    errorLogWithIP('삭제 API 핸들러 오류:', error, req);
    res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// 새 폴더 생성 (비동기화)
app.post('/api/folders', express.json(), async (req, res) => { // *** async 추가 ***
  const { folderPath, folderName } = req.body;
  if (!folderName) {
    return res.status(400).send('폴더 이름이 제공되지 않았습니다.');
  }

  // 폴더 이름 유효성 검사 (여기서는 간단히, 필요시 강화)
  if (/[/\\:*?"<>|]/g.test(folderName)) {
      return res.status(400).send('폴더 이름에 사용할 수 없는 문자가 포함되어 있습니다.');
  }

  const relativeFolderPath = folderPath || ''; // 기본값은 루트
  const fullPath = path.join(ROOT_DIRECTORY, relativeFolderPath, folderName);

  logWithIP(`[Folder Create] '${relativeFolderPath}/${folderName}' 생성 요청`, req, 'info'); // 레벨 변경: minimal -> info
  log(`새 폴더 생성 요청: ${fullPath}`, 'info');

  try {
    // *** 폴더 존재 확인 (비동기) ***
    try {
      await fs.promises.access(fullPath);
      // 폴더가 이미 존재하면 오류 반환 (access 성공 시)
      errorLogWithIP(`폴더가 이미 존재함: ${fullPath}`, null, req);
      return res.status(409).send('이미 존재하는 폴더 이름입니다.');
    } catch (error) {
      // 접근 오류(ENOENT) 발생 시 폴더가 없는 것이므로 정상 진행
      if (error.code !== 'ENOENT') {
        // ENOENT 외 다른 접근 오류는 서버 오류로 처리
        errorLogWithIP('폴더 존재 확인 중 접근 오류 발생', error, req);
        return res.status(500).send('폴더 생성 중 오류가 발생했습니다.');
      }
      // ENOENT는 정상, 계속 진행
    }

    // *** 폴더 생성 및 권한 설정 (비동기) ***
    // await fs.promises.mkdir(fullPath, { recursive: true }); // recursive는 상위 경로 자동 생성
    // await fs.promises.chmod(fullPath, 0o777);
    // log(`폴더 생성 완료 및 권한 설정: ${fullPath}`, 'info');

    // 특수문자를 완벽하게 이스케이프하는 함수
    
    const escapedPath = escapeShellArg(fullPath);
    const mkdirCommand = `mkdir -p -m 777 ${escapedPath}`;
    log(`폴더 생성 명령어 실행: ${mkdirCommand}`, 'debug');
    
    // util.promisify로 exec를 프로미스로 변환
    const { promisify } = require('util');
    const execPromise = promisify(require('child_process').exec);
    
    const { stdout, stderr } = await execPromise(mkdirCommand);
    if (stderr) {
      log(`mkdir stderr (정보): ${stderr.trim()}`, 'debug');
    }
    log(`폴더 생성 완료 및 권한 설정: ${fullPath}`, 'info');

    res.status(201).send('폴더가 성공적으로 생성되었습니다.');

  } catch (error) { // 폴더 생성/권한 설정 중 발생한 오류 또는 예기치 못한 오류 처리
    errorLogWithIP(`폴더 생성 중 오류 발생: ${fullPath}`, error, req);
    res.status(500).send('폴더 생성 중 오류가 발생했습니다.');
  }
});
// 로그 레벨 변경 API
app.put('/api/log-level', express.json(), (req, res) => { // !!!! express.json() 미들웨어 추가 !!!!
  const { level } = req.body;
  if (level && LOG_LEVELS.hasOwnProperty(level)) {
    setLogLevel(level);
    res.status(200).json({ success: true, message: `Log level set to ${level}` });
  } else {
    errorLogWithIP(`Invalid log level requested: ${level}`, null, req);
    res.status(400).json({ success: false, error: 'Invalid log level provided. Use minimal, info, or debug.' });
  }
});

// === 추가: 클라이언트 액션 로깅 API ===
app.post('/api/log-action', express.json(), (req, res) => {
  const { message, level = 'minimal' } = req.body; // 기본 레벨은 minimal

  if (!message) {
    // 메시지가 없으면 오류 응답
    return res.status(400).json({ success: false, error: 'Log message is required.' });
  }

  // 유효한 로그 레벨인지 확인 (선택적)
  if (!LOG_LEVELS.hasOwnProperty(level)) {
    errorLogWithIP(`Invalid log level received from client: ${level}`, null, req);
    return res.status(400).json({ success: false, error: 'Invalid log level provided.' });
  }

  // 로그 기록
  logWithIP(message, req, level);

  // 성공 응답
  res.status(200).json({ success: true });
});

// --- 서버 종료 처리 (SIGTERM 핸들러) ---
process.on('SIGTERM', () => {
  log('SIGTERM 신호 수신. 서버를 종료합니다.', 'info'); // 레벨 변경: minimal -> info

  // 활성 워커 프로세스들에게 종료 신호 보내기
  log(`활성 워커 ${activeWorkers.size}개에게 종료 신호를 보냅니다...`, 'info');
  activeWorkers.forEach(worker => {
    try {
      // SIGKILL을 보내 즉시 종료 시도
      if (!worker.killed) { // 이미 종료되지 않은 경우에만 시도
        worker.kill('SIGKILL'); 
        log(`워커 (PID: ${worker.pid})에게 SIGKILL 전송됨.`, 'debug');
      }
    } catch (err) {
      errorLog(`워커 (PID: ${worker.pid})에게 종료 신호 전송 중 오류:`, err);
    }
  });

  // 필요한 경우 추가적인 정리 작업 수행 (예: DB 연결 닫기 등)

  // 잠시 대기 후 프로세스 종료 (워커 종료 시간을 약간 확보)
  setTimeout(() => {
    log('서버 프로세스 종료.', 'info'); // 레벨 변경: minimal -> info
    process.exit(0); // 정상 종료
  }, 1000); // 1초 대기 (필요에 따라 조정)
});

// --- 서버 시작 로직 수정 (setupLogStreams 호출 제거) ---
async function startServer() {
  await initializeDirectories(); // 디렉토리 초기화 및 로그 스트림 설정 완료 대기
  // setupLogStreams(); // 여기서 호출 제거

  // *** 서버 시작 전 임시 디렉토리 정리 (추가) ***
  await cleanupTmpDirectory(); 

  // 서버 리스닝 시작
  app.listen(PORT, () => {
    log(`서버가 ${PORT} 포트에서 실행 중입니다. 로그 레벨: ${Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLogLevel)}`, 'minimal');
    log(`WebDAV 서버: http://localhost:${PORT}/webdav`, 'info');
  });
}

startServer(); // 서버 시작 함수 호출

// --- 쉘 인자 이스케이프 함수 정의 추가 ---
function escapeShellArg(arg) {
    // 윈도우 환경에서는 다른 방식이 필요할 수 있으나, 현재 리눅스 환경 기준으로 작성
    // 작은따옴표(')로 감싸고, 내부의 작은따옴표는 '\'' 로 변경
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// 새 폴더 생성 라우터
app.post('/api/files/:folderPath(*)', async (req, res) => {
  const folderPathRaw = req.params.folderPath;
  logWithIP(`새 폴더 생성 요청 수신 - Raw Path: ${folderPathRaw}`, req, 'info');

  if (!folderPathRaw) {
    errorLogWithIP('새 폴더 생성 오류: 경로가 비어있음', null, req);
    return res.status(400).json({ success: false, message: '폴더 경로가 필요합니다.' });
  }

  let decodedPath;
  try {
    // 경로 디코딩
    decodedPath = decodeURIComponent(folderPathRaw);
    logWithIP(`Decoded Path: ${decodedPath}`, req);
  } catch (e) {
    errorLogWithIP('새 폴더 생성 오류: 경로 디코딩 실패', e, req);
    return res.status(400).json({ success: false, message: '잘못된 경로 형식입니다.' });
  }

  const sanitizedPath = decodedPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const targetFullPath = path.join(ROOT_DIRECTORY, sanitizedPath);
  logWithIP(`Target Full Path: ${targetFullPath}`, req);

  // 보안 검사
  if (!targetFullPath.startsWith(ROOT_DIRECTORY + path.sep) && targetFullPath !== ROOT_DIRECTORY) {
    errorLogWithIP('새 폴더 생성 오류: 허용되지 않은 경로 접근 시도', { requestedPath: sanitizedPath, resolvedPath: targetFullPath }, req);
    return res.status(403).json({ success: false, message: '허용되지 않은 경로입니다.' });
  }
  const folderName = path.basename(sanitizedPath);
  if (/[\\/:*?"<>|]/.test(folderName)) {
      errorLogWithIP('새 폴더 생성 오류: 유효하지 않은 폴더 이름', { folderName: folderName }, req);
      return res.status(400).json({ success: false, message: '폴더 이름에 사용할 수 없는 문자가 포함되어 있습니다.' });
  }
  if (Buffer.byteLength(targetFullPath, 'utf8') > MAX_PATH_BYTES) {
    errorLogWithIP('새 폴더 생성 오류: 경로가 너무 김', { path: targetFullPath }, req);
    return res.status(400).json({ success: false, message: `경로가 너무 깁니다. (최대 ${MAX_PATH_BYTES} 바이트)` });
  }
  if (isPathAccessRestricted(sanitizedPath)) {
      errorLogWithIP('새 폴더 생성 오류: 대상 폴더 또는 상위 폴더 잠김', { path: sanitizedPath }, req);
      return res.status(403).json({ success: false, message: '대상 폴더 또는 상위 폴더가 잠겨 있어 생성할 수 없습니다.' });
  }

  // *** 직접 폴더 생성 로직 ***
  try {
    // recursive: true 옵션은 부모 디렉토리가 없으면 생성하고, 이미 폴더가 존재해도 오류를 발생시키지 않음 (Node.js v10.12.0+)
    // 하지만 명시적으로 존재 여부를 확인하고 싶다면 fs.promises.access 사용 가능
    // 여기서는 recursive: true를 사용하여 단순화
    await fs.promises.mkdir(targetFullPath, { recursive: true, mode: 0o777 });
    logWithIP(`폴더 생성 성공: ${targetFullPath}`, req, 'info');
    res.status(201).json({ success: true, message: '폴더 생성 성공' });
    // 디스크 사용량 갱신 (비동기)
    getDiskUsage().catch(err => errorLogWithIP('폴더 생성 후 디스크 사용량 갱신 오류', err, req));
  } catch (error) {
      // mkdir 자체에서 발생하는 오류 처리 (예: 권한 문제 EACCES, 디스크 공간 부족 ENOSPC 등)
      errorLogWithIP(`폴더 생성 실패: ${targetFullPath}`, error, req);
      // 이미 존재하는 경우는 recursive: true 로 인해 오류 발생 안 함
      if (error.code === 'EACCES') {
           res.status(403).json({ success: false, message: '폴더 생성 권한이 없습니다.' });
      } else {
           res.status(500).json({ success: false, message: '폴더 생성 중 오류가 발생했습니다.' });
      }
  }
  // *** 직접 생성 로직 끝 ***

  // --- 기존 워커 호출 로직 제거됨 --- 
});

// 파일 및 폴더 삭제 라우터 (기존 - 워커 사용)
app.post('/api/items/delete', async (req, res) => {
  // ... 기존 삭제 로직 (워커 사용) ...
});

// --- 폴더 잠금 관련 전역 변수 및 함수 --- 
let lockedFolders = []; // 잠긴 폴더 경로 목록 (메모리 저장)
const LOCK_FILE_PATH = path.join(__dirname, 'lockedFolders.json'); // !!!! 파일 이름 수정 !!!!

// 특수문자를 완벽하게 이스케이프하는 함수 (전역)
// function escapeShellArg(arg) {
//   // 모든 특수문자를 처리하기 위해 작은따옴표로 감싸고
//   // 내부의 작은따옴표, 백틱, 달러 기호 등을 이스케이프
//   return `'${arg.replace(/'/g, "'\\''")}'`;
// }

// 잠금 파일 로드 함수
async function loadLockedFolders() {
    try {
        await fs.promises.access(LOCK_FILE_PATH);
        const data = await fs.promises.readFile(LOCK_FILE_PATH, 'utf8');
        // !!!! JSON 파싱 로직 추가 !!!!
        const parsedData = JSON.parse(data);
        lockedFolders = parsedData.lockState || []; // lockState 배열 사용
        log(`잠긴 폴더 목록 로드 완료: ${lockedFolders.length}개`, 'info');
    } catch (error) {
        if (error.code === 'ENOENT') {
            // !!!! 로그 메시지 수정 !!!!
            log('잠금 파일(lockedFolders.json)이 존재하지 않아 새로 시작합니다.', 'info');
            lockedFolders = [];
            // !!!! 파일 없을 때 빈 파일 생성 로직 추가 !!!!
            try {
                await fs.promises.writeFile(LOCK_FILE_PATH, JSON.stringify({ lockState: [] }), 'utf8');
                log('새 잠금 파일(lockedFolders.json) 생성됨.', 'info');
            } catch (writeError) {
                errorLog('새 잠금 파일 생성 오류:', writeError);
            }
        } else {
            // !!!! JSON 파싱 오류 처리 추가 !!!!
            errorLog('잠금 파일 로드 또는 파싱 중 오류 발생', error);
            lockedFolders = []; // 오류 시 빈 목록으로 초기화
        }
    }
}

// 잠금 파일 저장 함수
async function saveLockedFolders() {
    try {
        // !!!! JSON 형식으로 저장 !!!!
        await fs.promises.writeFile(LOCK_FILE_PATH, JSON.stringify({ lockState: lockedFolders }, null, 2), 'utf8'); 
        log('잠긴 폴더 목록 저장 완료', 'debug');
    } catch (error) {
        errorLog('잠금 파일 저장 중 오류 발생', error);
    }
}

// *** isPathAccessRestricted 함수 정의 추가 ***
// 주어진 경로 또는 그 상위 경로가 잠겨 있는지 확인하는 함수
function isPathAccessRestricted(targetPath) {
    if (!targetPath) return false; // 빈 경로는 잠기지 않음
    const normalizedTargetPath = targetPath.replace(/^\/+/, '').replace(/\/+$/, ''); // 정규화
    
    // 자기 자신 또는 상위 경로 중 하나라도 잠겨 있으면 접근 제한
    return lockedFolders.some(lockedPath => {
        const normalizedLockedPath = lockedPath.replace(/^\/+/, '').replace(/\/+$/, '');
        // 대상 경로가 잠긴 경로 자체이거나, 잠긴 경로로 시작하는 경우 (하위 경로 포함)
        return normalizedTargetPath === normalizedLockedPath || 
               normalizedTargetPath.startsWith(normalizedLockedPath + '/') ||
               // 대상 경로의 상위 경로 중 하나가 잠긴 경로인 경우
               normalizedLockedPath.startsWith(normalizedTargetPath + '/');
    });
}
// *** 함수 정의 끝 ***

// ===== 테스트용 파일 업로드 라우트 시작 =====
const testUploadStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const testUploadDir = path.join(ROOT_DIRECTORY, 'test-uploads');
    // 테스트 디렉토리 생성 (없으면)
    fs.promises.mkdir(testUploadDir, { recursive: true })
      .then(() => cb(null, testUploadDir))
      .catch(err => cb(err));
  },
  filename: function (req, file, cb) {
    // 원본 파일명 사용 (테스트 목적)
    cb(null, file.originalname);
  }
});

const testUploadMiddleware = multer({ storage: testUploadStorage });

app.post('/api/upload/test', testUploadMiddleware.single('testFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('테스트 파일이 업로드되지 않았습니다.');
  }
  logWithIP(`[Test Upload] 파일 '${req.file.originalname}'이(가) test-uploads 폴더에 저장되었습니다.`, req, 'info');
  res.status(200).json({ 
    message: '테스트 파일 업로드 성공', 
    filename: req.file.originalname,
    path: req.file.path 
  });
});
// ===== 테스트용 파일 업로드 라우트 끝 =====

// --- 서버 시작 전 임시 디렉토리 정리 함수 (추가) ---
const cleanupTmpDirectory = async () => {
  const tmpDir = path.join(__dirname, 'tmp');
  log(`서버 시작 전 임시 디렉토리 정리 시작: ${tmpDir}`, 'info');
  try {
    const items = await fs.promises.readdir(tmpDir);
    if (items.length === 0) {
      log('임시 디렉토리가 비어있습니다. 정리할 항목 없음.', 'info');
      return;
    }
    log(`${items.length}개의 항목을 임시 디렉토리에서 삭제합니다...`, 'info');

    const execPromise = util.promisify(require('child_process').exec);
    const cleanupPromises = items.map(async (item) => {
      const itemPath = path.join(tmpDir, item);
      const escapedPath = escapeShellArg(itemPath);
      const command = `rm -rf ${escapedPath}`;
      try {
        log(`임시 항목 삭제 명령어 실행: ${command}`, 'debug');
        const { stdout, stderr } = await execPromise(command);
        if (stderr) {
          log(`임시 항목 삭제 중 stderr 발생 (${item}): ${stderr.trim()}`, 'debug'); // 오류가 아니어도 로깅
        }
        log(`임시 항목 삭제 완료: ${itemPath}`, 'debug');
      } catch (error) {
        errorLog(`임시 항목 삭제 실패: ${itemPath}`, error);
        // 개별 항목 삭제 실패 시 전체 중단하지 않음
      }
    });

    await Promise.allSettled(cleanupPromises); // 모든 삭제 시도 완료까지 대기
    log('임시 디렉토리 정리 완료.', 'info');

  } catch (error) {
    if (error.code === 'ENOENT') {
      log('임시 디렉토리가 존재하지 않습니다. 정리 건너뜀.', 'info');
    } else {
      errorLog('임시 디렉토리 정리 중 오류 발생:', error);
    }
  }
};

// 외부에서 사용할 수 있도록 함수 노출 (추가)
module.exports = {
  app: app, // 기존 Express 앱 객체 (만약 필요하다면)
  cleanupTmpDirectory: cleanupTmpDirectory,
  // 다른 필요한 함수나 변수가 있다면 여기에 추가
};

// TUS 서버 마운트 (다른 app.use 또는 라우트 설정 이후, 서버 시작 전)
mountTusServer(app);
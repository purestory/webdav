// tus-utils.js - TUS 서버와 메인 서버 간 공유 유틸리티 함수

// 파일명 정리 함수
function sanitizeFilename(filename) {
    if (!filename) return '';
    return filename.replace(/[\/\\:*?"<>|]/g, '_');
}

// 로깅 함수
function log(message, level = 'info') {
    console.log(`[${level.toUpperCase()}] ${message}`);
    // 나중에 server.js의 실제 로깅 함수를 불러와 업데이트할 수 있음
}

function errorLog(message, error) {
    console.error(`[ERROR] ${message}`, error);
    // 나중에 server.js의 실제 오류 로깅 함수를 불러와 업데이트할 수 있음
}

// 디스크 사용량 업데이트 함수 (임시)
async function updateDiskUsage() {
    // 여기서는 성공만 반환
    return true;
}

module.exports = {
    sanitizeFilename,
    log,
    errorLog,
    updateDiskUsage
};
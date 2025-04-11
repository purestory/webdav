/**
 * TUS 서버 이벤트 테스트 유틸리티
 * 사용법: node util/tus-test/tus-event-test.js
 */

const tus = require('@tus/server');
const TusServer = tus.Server;
const EVENTS = tus.EVENTS;
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 테스트 환경 설정
const TEST_PORT = 3334;
const TEST_STORAGE_DIR = path.join(__dirname, 'test-storage');
const API_PATH = '/api/tus/test/';

// 스토리지 디렉토리 생성
if (!fs.existsSync(TEST_STORAGE_DIR)) {
    fs.mkdirSync(TEST_STORAGE_DIR, { recursive: true });
    console.log(`테스트 스토리지 디렉토리 생성: ${TEST_STORAGE_DIR}`);
}

// 이벤트 카운터
const eventCounter = {
    FILE_CREATED: 0,
    UPLOAD_COMPLETE: 0
};

// 테스트 TUS 서버 생성
const tusServer = new TusServer({
    path: API_PATH,
    datastore: new FileStore({
        directory: TEST_STORAGE_DIR,
    }),
    namingFunction: () => {
        return Date.now().toString();
    }
});

// 이벤트 리스너 직접 등록 방식 1 - 표준 방식
tusServer.on(EVENTS.EVENT_FILE_CREATED, (event) => {
    console.log(`[방식1] 파일 생성 이벤트 발생: ${event.file.id}`);
    eventCounter.FILE_CREATED++;
});

// 이벤트 리스너 직접 등록 방식 2 - 비동기 핸들러 사용
tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, (event) => {
    console.log(`[방식2] 업로드 완료 이벤트 발생: ${event.file.id}`);
    
    // 비동기 핸들러 호출
    setTimeout(async () => {
        console.log(`[방식2] 비동기 핸들러에서 파일 처리 시작: ${event.file.id}`);
        eventCounter.UPLOAD_COMPLETE++;
        
        // 메타데이터 확인
        console.log(`파일 메타데이터:`, event.file.metadata);
        
        // 테스트 요약 출력
        console.log(`\n========== 이벤트 테스트 결과 ==========`);
        console.log(`FILE_CREATED 이벤트 발생 횟수: ${eventCounter.FILE_CREATED}`);
        console.log(`UPLOAD_COMPLETE 이벤트 발생 횟수: ${eventCounter.UPLOAD_COMPLETE}`);
        console.log(`=========================================\n`);
    }, 500);
});

// 표준 HTTP 서버 생성 및 TUS 연결
const server = http.createServer((req, res) => {
    if (req.url.startsWith(API_PATH)) {
        console.log(`[요청] ${req.method} ${req.url}`);
        return tusServer.handle(req, res);
    } else if (req.url === '/') {
        // 간단한 HTML 업로드 폼 제공
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>TUS 이벤트 테스트</title>
                <script src="https://cdn.jsdelivr.net/npm/tus-js-client@3.0.1/dist/tus.min.js"></script>
            </head>
            <body>
                <h1>TUS 이벤트 테스트</h1>
                <input type="file" id="fileInput" />
                <button id="uploadBtn">업로드</button>
                <div id="status"></div>
                
                <script>
                    document.getElementById('uploadBtn').addEventListener('click', function() {
                        const fileInput = document.getElementById('fileInput');
                        const file = fileInput.files[0];
                        if (!file) {
                            alert('파일을 선택해주세요.');
                            return;
                        }
                        
                        const status = document.getElementById('status');
                        status.textContent = '업로드 준비 중...';
                        
                        // TUS 클라이언트 생성
                        const upload = new tus.Upload(file, {
                            endpoint: '/api/tus/test/',
                            retryDelays: [0, 1000, 3000, 5000],
                            metadata: {
                                filename: file.name,
                                filetype: file.type,
                                targetPath: '테스트',
                                relativePath: file.name
                            },
                            onError: function(error) {
                                status.textContent = '업로드 오류: ' + error;
                            },
                            onProgress: function(bytesUploaded, bytesTotal) {
                                const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
                                status.textContent = '업로드 중... ' + percentage + '%';
                            },
                            onSuccess: function() {
                                status.textContent = '업로드 완료!';
                            }
                        });
                        
                        // 업로드 시작
                        upload.start();
                    });
                </script>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// 서버 시작
server.listen(TEST_PORT, () => {
    console.log(`\n=========================================`);
    console.log(`TUS 이벤트 테스트 서버가 시작되었습니다.`);
    console.log(`URL: http://localhost:${TEST_PORT}/`);
    console.log(`TUS 엔드포인트: ${API_PATH}`);
    console.log(`테스트 방법: 브라우저에서 위 URL에 접속하여 파일 업로드 테스트`);
    console.log(`=========================================\n`);
}); 
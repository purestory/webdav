// 공유 유틸리티 함수들을 사용하기 위해 tus-utils.js 모듈 로드
// 순환 참조 문제를 해결하기 위해 tusUtils의 함수를 server.js의 함수로 덮어쓰는 대신,
// server.js에서 tus-utils.js 모듈을 사용하는 방식으로 변경
const tusUtils = require('./tus-utils');

// TUS 서버 마운트 (다른 app.use 또는 라우트 설정 이후, 서버 시작 전)
mountTusServer(app); 
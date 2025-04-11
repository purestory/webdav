/**
 * TUS 서버 이벤트 핸들러 모의 테스트
 * 사용법: node util/tus-test/mock-event-test.js
 */

const tus = require('@tus/server');
const EVENTS = tus.EVENTS;
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

console.log("======= TUS 이벤트 핸들러 모의 테스트 =======");

// 실제 tus-server.js 코드에서 필요한 부분 가져옴
// 파일 경로 설정
const BACKEND_DIR = path.join(__dirname, '../../backend');
const tusStorageDir = path.join(BACKEND_DIR, 'tus-storage');
const finalStorageDir = path.join(BACKEND_DIR, 'share-folder');

// 테스트용 파일 준비
const MOCK_FILE_ID = `test_${Date.now()}`;
const MOCK_META = {
    filename: 'test-file.txt',
    relativePath: 'test-file.txt',
    targetPath: 'test'
};

// 테스트 파일 생성
async function setupTestFile() {
    console.log("1. 테스트 파일 준비 중...");
    
    // 디렉토리 확인
    if (!fsSync.existsSync(tusStorageDir)) {
        fsSync.mkdirSync(tusStorageDir, { recursive: true });
    }
    
    // 테스트 파일 경로
    const testFilePath = path.join(tusStorageDir, MOCK_FILE_ID);
    const metaFilePath = path.join(tusStorageDir, `${MOCK_FILE_ID}.json`);
    
    // 테스트 파일 생성
    await fs.writeFile(testFilePath, 'This is a test file content');
    await fs.writeFile(metaFilePath, JSON.stringify({
        id: MOCK_FILE_ID,
        metadata: MOCK_META
    }));
    
    console.log(`테스트 파일 생성 완료: ${testFilePath}`);
    console.log(`메타데이터 파일 생성 완료: ${metaFilePath}`);
    
    return { testFilePath, metaFilePath };
}

// tus-server.js의 파일 처리 함수 모의 구현
async function processTusFile(file) {
    console.log("3. processTusFile 함수 실행...");
    console.log(`파일 ID: ${file.id}`);
    console.log(`메타데이터:`, file.metadata);
    
    try {
        // 1. 메타데이터 검증
        const metadata = file.metadata || {};
        if (!metadata.filename) {
            console.error("메타데이터에 filename이 없습니다.");
            return false;
        }
        
        // 2. 경로 계산
        const targetPathBase = metadata.targetPath || '';
        const originalFilename = metadata.filename;
        const dirPath = path.dirname(metadata.relativePath) === '.' ? '' : path.dirname(metadata.relativePath);
        
        const finalDirPath = path.join(finalStorageDir, targetPathBase, dirPath);
        const finalFilePath = path.join(finalDirPath, originalFilename);
        
        console.log(`최종 디렉토리: ${finalDirPath}`);
        console.log(`최종 파일 경로: ${finalFilePath}`);
        
        // 3. 대상 디렉토리 생성
        if (!fsSync.existsSync(finalDirPath)) {
            await fs.mkdir(finalDirPath, { recursive: true, mode: 0o777 });
            console.log(`대상 디렉토리 생성됨: ${finalDirPath}`);
        }
        
        // 4. 파일 이동 (복사 후 삭제)
        const sourcePath = path.join(tusStorageDir, file.id);
        try {
            // 파일 존재 확인
            if (fsSync.existsSync(sourcePath)) {
                console.log(`소스 파일 확인: ${sourcePath} (존재함)`);
                
                // 복사
                await fs.copyFile(sourcePath, finalFilePath);
                console.log(`파일 복사 성공: ${finalFilePath}`);
                
                // 원본 삭제
                await fs.unlink(sourcePath);
                console.log(`원본 파일 삭제 성공: ${sourcePath}`);
                
                // 메타 파일 삭제
                const metaFile = path.join(tusStorageDir, `${file.id}.json`);
                if (fsSync.existsSync(metaFile)) {
                    await fs.unlink(metaFile);
                    console.log(`메타데이터 파일 삭제: ${metaFile}`);
                }
                
                return true;
            } else {
                console.error(`소스 파일이 존재하지 않음: ${sourcePath}`);
                return false;
            }
        } catch (error) {
            console.error(`파일 이동 중 오류 발생:`, error);
            return false;
        }
    } catch (error) {
        console.error(`파일 처리 중 오류 발생:`, error);
        return false;
    }
}

// 처리 중인 파일 추적을 위한 Map
const processingFiles = new Map();

// 비동기 핸들러 함수
function handleCompletedUpload(file) {
    console.log("2. handleCompletedUpload 함수 실행...");
    console.log(`파일 ID: ${file.id}`);
    
    if (!file || !file.id) {
        console.error("유효하지 않은 파일 객체");
        return;
    }
    
    // 이미 처리 중인지 확인
    if (processingFiles.has(file.id)) {
        console.log(`파일 ${file.id}는 이미 처리 중입니다. 건너뜁니다.`);
        return;
    }
    
    // 처리 중으로 표시
    processingFiles.set(file.id, true);
    
    // 비동기 처리 시작
    setTimeout(async () => {
        try {
            console.log(`파일 ID ${file.id} 처리 시작`);
            const result = await processTusFile(file);
            console.log(`파일 처리 결과: ${result ? '성공' : '실패'}`);
        } catch (error) {
            console.error(`handleCompletedUpload 오류:`, error);
        } finally {
            // 처리 완료 후 Map에서 제거
            processingFiles.delete(file.id);
        }
    }, 100);
}

// 메인 테스트 코드
async function runTest() {
    try {
        console.log("\n=== TUS 이벤트 핸들러 테스트 시작 ===\n");
        
        // 테스트 파일 준비
        const { testFilePath, metaFilePath } = await setupTestFile();
        
        // 모의 파일 객체 생성
        const mockFile = {
            id: MOCK_FILE_ID,
            metadata: MOCK_META
        };
        
        // 이벤트 핸들러 실행
        handleCompletedUpload(mockFile);
        
        // 테스트 결과 확인을 위해 대기
        console.log("\n잠시 후 처리 결과를 확인합니다...");
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 결과 확인
        const targetDir = path.join(finalStorageDir, MOCK_META.targetPath);
        const finalPath = path.join(targetDir, MOCK_META.filename);
        
        console.log("\n=== 테스트 결과 확인 ===");
        
        // 대상 파일 존재 확인
        const targetExists = fsSync.existsSync(finalPath);
        console.log(`최종 파일 존재 여부: ${targetExists ? '존재함' : '존재하지 않음'} (${finalPath})`);
        
        // 소스 파일 존재 확인 (삭제되었어야 함)
        const sourceExists = fsSync.existsSync(testFilePath);
        console.log(`소스 파일 존재 여부: ${sourceExists ? '여전히 존재함 (실패)' : '삭제됨 (성공)'} (${testFilePath})`);
        
        // 메타 파일 존재 확인 (삭제되었어야 함)
        const metaExists = fsSync.existsSync(metaFilePath);
        console.log(`메타 파일 존재 여부: ${metaExists ? '여전히 존재함 (실패)' : '삭제됨 (성공)'} (${metaFilePath})`);
        
        console.log("\n=== 테스트 완료 ===");
    } catch (error) {
        console.error("테스트 실행 중 오류 발생:", error);
    }
}

// 테스트 실행
runTest(); 
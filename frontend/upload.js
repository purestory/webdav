

let isCancelled = false;
let currentUploads = {}; // 진행 중인 TUS 업로드 객체 관리 (파일별)
let totalBytesToUpload = 0;
let totalBytesUploaded = 0;
let uploadedFileCount = 0; // 완료된 파일 수
let totalFilesToUpload = 0; // 전체 업로드 파일 수

// 업로드 속도 및 시간 계산 관련 변수 (기존 로직 활용 가능)
let startTime = 0;
let lastOverallUploaded = 0; // 전체 업로드 바이트 (속도 계산용)
let lastSpeedCalcTime = 0; // 마지막 속도 계산 시간
const speedHistory = [];
const SPEED_HISTORY_COUNT = 10; // 속도 평균 계산 시 사용할 기록 수

// DOM 요소 (기존과 동일, 필요시 showUploadModal에서 가져옴)
let uploadProgressModal = null;
let overallProgressBar = null;
let overallProgressText = null;
let currentFileInfo = null;
let uploadSpeedEl = null; // 이름 변경 (uploadSpeed -> uploadSpeedEl)
let uploadTimeRemainingEl = null; // 이름 변경 (uploadTimeRemaining -> uploadTimeRemainingEl)
let totalUploadSizeEl = null;

// 백엔드 TUS 엔드포인트
const TUS_ENDPOINT = `${API_BASE_URL}/api/tus/upload/`; // 백엔드 tus-server.js 에 설정된 경로


// --- 업로드 모달 표시/숨김 (기존과 유사하게 UI 초기화) ---
function showUploadModal() {
    // DOM 요소 가져오기 (기존과 동일)
    uploadProgressModal = document.getElementById('upload-progress-modal');
    overallProgressBar = document.getElementById('overall-progress-bar');
    overallProgressText = document.getElementById('overall-progress-text');
    currentFileInfo = document.getElementById('current-file-info');
    uploadSpeedEl = document.getElementById('upload-speed'); // ID 확인 및 할당
    uploadTimeRemainingEl = document.getElementById('upload-time-remaining'); // ID 확인 및 할당
    totalUploadSizeEl = document.getElementById('total-upload-size'); // ID 확인 및 할당

    if (!uploadProgressModal || !overallProgressBar || !overallProgressText || !currentFileInfo || !uploadSpeedEl || !uploadTimeRemainingEl || !totalUploadSizeEl) {
        logError('필수 모달 요소(#upload-progress-modal, ...)를 찾을 수 없습니다.');
        return;
    }

    // 상태 변수 초기화
    isCancelled = false;
    currentUploads = {};
    totalBytesToUpload = 0;
    totalBytesUploaded = 0;
    uploadedFileCount = 0;
    totalFilesToUpload = 0;
    startTime = Date.now();
    lastOverallUploaded = 0;
    lastSpeedCalcTime = startTime;
    speedHistory.length = 0;

    // UI 초기화 (기존과 동일)
    overallProgressBar.style.width = '0%';
    overallProgressText.textContent = '전체 진행률: 0% (0/0 파일)';
    totalUploadSizeEl.textContent = '업로드: 0 B / 0 B';
    currentFileInfo.textContent = '업로드 준비 중...';
    uploadSpeedEl.textContent = '속도: 0 KB/s';
    uploadTimeRemainingEl.textContent = '남은 시간: 계산 중...';

    uploadProgressModal.style.display = 'flex';
    logLog('업로드 모달 표시 및 초기화 완료');
}

function hideUploadModal() {
    if (uploadProgressModal) {
        uploadProgressModal.style.display = 'none';
    }
    logLog('업로드 모달 숨김');
    
    // 모든 업로드가 이미 완료된 경우는 취소 함수 호출하지 않음
    // uploadedFileCount === totalFilesToUpload인 경우 모든 업로드가 완료된 상태
    if (!(uploadedFileCount > 0 && uploadedFileCount === totalFilesToUpload)) {
        cancelUpload();
    }
}


// --- 파일 크기 포맷팅 함수 (기존과 동일) ---
function formatFileSize(bytes) {
    if (bytes === 0 || isNaN(bytes) || !isFinite(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k));
    // 소수점 두 자리까지, 0 B 일때는 정수로
    const num = parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2));
    return num + ' ' + sizes[Math.min(i, sizes.length - 1)];
}


// --- 속도 및 남은 시간 업데이트 (TUS onProgress 에서 호출) ---
function updateSpeedAndTime() {
    const now = Date.now();
    // 최소 0.5초 간격으로 계산
    if (now - lastSpeedCalcTime < 500) return;

    const elapsedSinceLast = (now - lastSpeedCalcTime) / 1000; // 초 단위
    const bytesUploadedSinceLast = totalBytesUploaded - lastOverallUploaded;

    if (elapsedSinceLast > 0) {
        const currentSpeed = bytesUploadedSinceLast / elapsedSinceLast; // 현재 구간 평균 속도

        // 속도 기록 업데이트 (기존과 동일)
        if (currentSpeed >= 0 && isFinite(currentSpeed)) { // 0 이상 유효한 값만
             speedHistory.push(currentSpeed);
             if (speedHistory.length > SPEED_HISTORY_COUNT) {
                 speedHistory.shift();
             }
        }

        let weightedSpeed = 0;
        let totalWeight = 0;
        for (let i = 0; i < speedHistory.length; i++) {
            const weight = i + 1;
            weightedSpeed += speedHistory[i] * weight;
            totalWeight += weight;
        }
        const averageSpeed = totalWeight > 0 ? weightedSpeed / totalWeight : 0; // 이동 평균 속도

        // 남은 바이트 계산
        const remainingBytes = Math.max(0, totalBytesToUpload - totalBytesUploaded);
        let remainingTimeStr = '계산 중...';

        if (averageSpeed > 0 && remainingBytes > 0) {
            const secondsRemaining = Math.ceil(remainingBytes / averageSpeed);
            if (secondsRemaining < 60) {
                remainingTimeStr = `${secondsRemaining}초`;
            } else if (secondsRemaining < 3600) {
                remainingTimeStr = `${Math.floor(secondsRemaining / 60)}분 ${secondsRemaining % 60}초`;
            } else {
                remainingTimeStr = `${Math.floor(secondsRemaining / 3600)}시간 ${Math.floor((secondsRemaining % 3600) / 60)}분`;
            }
        } else if (remainingBytes === 0 && totalBytesToUpload > 0) {
            remainingTimeStr = '완료';
        }

        // UI 업데이트
        if (uploadSpeedEl) {
             uploadSpeedEl.textContent = `속도: ${formatFileSize(averageSpeed)}/s`;
        }
        if (uploadTimeRemainingEl) {
             uploadTimeRemainingEl.textContent = `남은 시간: ${remainingTimeStr}`;
        }

        // 마지막 계산 값 업데이트
        lastOverallUploaded = totalBytesUploaded;
        lastSpeedCalcTime = now;
    }
}

// --- 전체 진행률 업데이트 (TUS onProgress 및 onSuccess 에서 호출) ---
function updateOverallProgress(currentFileName = '') {
    if (!overallProgressBar || !overallProgressText || !totalUploadSizeEl || !currentFileInfo) {
        logWarn('진행률 UI 요소가 준비되지 않았습니다.');
        return;
    }

    const overallPercent = totalBytesToUpload > 0 ? Math.round((totalBytesUploaded / totalBytesToUpload) * 100) : 0;

    overallProgressBar.style.width = `${overallPercent}%`;
    overallProgressText.textContent = `전체 진행률: ${overallPercent}% (${uploadedFileCount}/${totalFilesToUpload} 파일)`;
    totalUploadSizeEl.textContent = `업로드: ${formatFileSize(totalBytesUploaded)} / ${formatFileSize(totalBytesToUpload)}`;

    // 현재 처리 중인 파일 이름 업데이트 (진행 중일 때만)
    if (currentFileName) {
        const displayPath = currentFileName.replace(/\\\\/g, '/'); // 경로 구분자 통일
         currentFileInfo.textContent = `현재 파일: ${displayPath}`;
    } else if (uploadedFileCount === totalFilesToUpload && totalFilesToUpload > 0) {
         currentFileInfo.textContent = '모든 파일 업로드 완료';
    } else if (isCancelled) {
        currentFileInfo.textContent = '업로드 취소됨';
    }
    // 속도 및 남은 시간 업데이트 호출
    updateSpeedAndTime();
}


// --- TUS 파일 업로드 시작 함수 ---
// filesWithPaths: [{ file: File, relativePath: string }, ...] 형태의 배열
// targetPath: 기본 대상 폴더 경로 (예: 사용자가 현재 보고 있는 폴더)
async function startTusUpload(filesWithPaths, targetPath = '') {
    logLog(`TUS 업로드 시작 요청. 파일 수: ${filesWithPaths.length}, 대상 경로: '${targetPath || 'root'}'`);
    showUploadModal(); // 모달 표시 및 초기화

    totalFilesToUpload = filesWithPaths.length;
    totalBytesToUpload = filesWithPaths.reduce((sum, item) => sum + item.file.size, 0);

    // 초기 UI 업데이트 (파일 수, 총 용량)
    updateOverallProgress();

    // 서버에 업로드 시작 로그 전송 (기존 방식 활용 가능)
    logUploadActionStart(filesWithPaths, targetPath);

    // 각 파일을 TUS로 업로드 시작
    filesWithPaths.forEach((item, index) => {
        if (isCancelled) return; // 취소 상태면 새 업로드 시작 안 함

        const file = item.file;
        const relativePath = item.relativePath; // 폴더 내 파일의 상대 경로
        const fileId = `${relativePath}-${file.size}-${file.lastModified}`; // 업로드 재개를 위한 고유 ID (개선 필요)

        // 메타데이터 구성
        const metadata = {
            filename: file.name, // 원본 파일명
            relativePath: encodeURIComponent(relativePath || file.name), // 폴더 구조 포함, URI 인코딩
            targetPath: targetPath // 기본 업로드 대상 폴더
            // 필요시 다른 메타데이터 추가 가능 (e.g., contentType)
        };
        if (file.type) {
           metadata.filetype = file.type; // MIME 타입 추가 (선택적)
        }

        const upload = new tus.Upload(file, {
            endpoint: TUS_ENDPOINT,
            retryDelays: [0, 3000, 5000, 10000, 20000], // 재시도 간격
            metadata: metadata,
            // fingerprint는 파일 고유 식별 및 이어올리기에 중요
            // 파일 내용, 이름, 크기, 수정일 등을 조합하여 생성
            fingerprint: function (fileForFingerprint, options) {
                // 파일 자체보다는 메타데이터와 파일 정보를 조합하는 것이 더 안정적일 수 있음
                // 예: 상대경로 + 파일명 + 크기 + 수정일시
                const uniqueString = `tus-${relativePath || fileForFingerprint.name}-${fileForFingerprint.size}-${fileForFingerprint.lastModified}`;
                // 간단한 해싱 또는 직접 사용 (충돌 가능성 낮추려면 해싱 권장)
                // 여기서는 간단히 문자열 반환
                // logLog(`Fingerprint for ${metadata.filename}: ${uniqueString}`);
                return Promise.resolve(uniqueString);
            },
            onProgress: (bytesUploaded, bytesTotal) => {
                // 개별 파일 진행률 (bytesUploaded / bytesTotal)
                // 전체 진행률 업데이트
                // 주의: 여러 파일 동시 진행 시 totalBytesUploaded 를 정확히 계산해야 함
                // currentUploads 객체를 사용하여 각 파일의 현재 업로드된 바이트를 추적
                if (currentUploads[fileId]) {
                    const previousUploaded = currentUploads[fileId].uploadedBytes || 0;
                    const delta = bytesUploaded - previousUploaded;
                    totalBytesUploaded += delta; // 전체 업로드 바이트 업데이트
                    currentUploads[fileId].uploadedBytes = bytesUploaded; // 현재 파일 업로드 바이트 갱신
                }
                // 전체 UI 업데이트 (현재 파일 이름 전달)
                updateOverallProgress(relativePath || file.name);
                // logLog(`Progress for ${metadata.filename}: ${bytesUploaded} / ${bytesTotal}`);
            },
            onSuccess: () => {
                logLog(`TUS Upload Success: ${metadata.filename}`);
                if (isCancelled) return; // 취소된 경우 성공 처리 안 함

                if (currentUploads[fileId]) {
                    // 누락된 바이트 보정 (onProgress가 100% 아닐 수 있음)
                    const finalBytes = file.size;
                    const delta = finalBytes - (currentUploads[fileId].uploadedBytes || 0);
                    if (delta > 0) {
                        totalBytesUploaded += delta;
                    }
                     uploadedFileCount++; // 완료된 파일 수 증가
                    delete currentUploads[fileId]; // 완료된 업로드 정보 제거
                    updateOverallProgress(); // 최종 UI 업데이트 (파일 이름 없이)
                }

                 // 모든 파일 완료 시 모달 처리 등
                if (uploadedFileCount === totalFilesToUpload) {
                     handleAllUploadsComplete();
                }
            },
            onError: (error) => {
                logError(`TUS Upload Error for ${metadata.filename}:`, error);
                if (isCancelled) return; // 취소 중 발생한 오류는 무시할 수 있음

                 // 실패 처리
                 if (currentUploads[fileId]) {
                     // 실패한 파일은 전체 업로드 바이트에서 제외 (이미 더해진 부분 차감)
                     // totalBytesUploaded -= currentUploads[fileId].uploadedBytes || 0; // 차감 로직은 복잡, 일단 유지
                     delete currentUploads[fileId]; // 실패한 업로드 정보 제거
                 }
                 totalFilesToUpload--; // 전체 파일 수에서 실패한 파일 제외? or 실패 카운트?
                 // TODO: 실패 목록 관리 및 사용자에게 알림
                 updateOverallProgress(); // UI 업데이트

                 // 모든 시도(업로드+재시도) 완료 후 모달 처리 등
                 if (Object.keys(currentUploads).length === 0 && (uploadedFileCount + /* failedCount */ 0 === filesWithPaths.length)) {
                      handleAllUploadsComplete(/* pass error info */);
                 }
            }
        });

        // 생성된 TUS Upload 객체 저장 (취소 등 관리를 위해)
        currentUploads[fileId] = { upload, uploadedBytes: 0 };

        // 업로드 시작
        logLog(`Starting TUS upload for: ${metadata.filename}`);
        upload.start();
    });
}

// --- 모든 업로드 완료 시 처리 ---
function handleAllUploadsComplete() {
    logLog(`모든 TUS 업로드 시도 완료. 성공: ${uploadedFileCount}/${totalFilesToUpload}`);
    
    // 완료 상태 설정 (직접 UI 업데이트)
    if (uploadProgressModal) {
        if (currentFileInfo) {
            currentFileInfo.textContent = '모든 파일 업로드 완료';
        }
    }
    
    // 약간의 지연 후 모달 숨기기
    setTimeout(() => {
        // 모달 직접 숨김 처리 (cancelUpload 호출 방지)
        if (uploadProgressModal) {
            uploadProgressModal.style.display = 'none';
            logLog('업로드 모달 숨김 (완료)');
        }
        
        // 성공/실패 요약 메시지
        if (typeof showToast === 'function') {
            if (uploadedFileCount === totalFilesToUpload) {
                showToast(`${totalFilesToUpload}개 파일 업로드 완료`, 'success');
            } else {
                showToast(`파일 업로드 완료 (${uploadedFileCount} 성공, ${totalFilesToUpload - uploadedFileCount} 실패)`, 'warning');
            }
        }
        
        // 파일 목록 새로고침
        if (typeof loadFiles === 'function') {
            loadFiles(currentPath);
        }
    }, 1500);
}








// --- 업로드 취소 함수 ---
function cancelUpload() {
    if (isCancelled) return; // 이미 취소됨
    isCancelled = true;
    logWarn('업로드 취소 요청됨.');

    Object.values(currentUploads).forEach(({ upload }) => {
        try {
            upload.abort(true); // true: 서버에도 중단 요청 시도
            logLog(`TUS upload aborted for: ${upload.options.metadata.filename}`);
        } catch (e) {
            logError('업로드 중단 중 오류 발생:', e);
        }
    });

    currentUploads = {}; // 진행 중 목록 비우기
    updateOverallProgress(); // UI 업데이트 (취소 상태 반영)

    // 모달 즉시 숨기거나, 취소 완료 메시지 후 숨기기
    // hideUploadModal();
     setTimeout(() => {
        hideUploadModal();
        if (typeof showToast === 'function') showToast('업로드가 취소되었습니다.', 'info');
    }, 500);
}

// --- 서버에 업로드 시작 액션 로깅 함수 ---
function logUploadActionStart(filesWithPaths, targetPath) {
     // 이 함수는 기존 server.js 의 /api/log-action 엔드포인트를 사용한다고 가정
     // 필요한 경우 이 함수 내용도 수정
     let logMessage = `[Upload Action] `;
     const totalFiles = filesWithPaths.length;
     let fileSummary = '';
     if (totalFiles === 1) {
         fileSummary = `\'${filesWithPaths[0].relativePath || filesWithPaths[0].file.name}\'`;
     } else {
         const firstFiles = filesWithPaths.slice(0, 2).map(item => `\'${item.relativePath || item.file.name}\'`).join(', ');
         fileSummary = `${firstFiles}${totalFiles > 2 ? ` 외 ${totalFiles - 2}개` : ''} (${totalFiles}개)`;
     }
     logMessage += `${fileSummary} TUS 업로드 시작.`; // 메시지 수정
     logMessage += ` 총 용량: ${formatFileSize(totalBytesToUpload)}.`;
     const targetDir = targetPath || '루트';
     logMessage += ` 대상 경로: ${targetDir}`;

     fetch(`${API_BASE_URL}/api/log-action`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ message: logMessage, level: 'minimal' }) // 로그 레벨 확인
     }).catch(error => logError('업로드 시작 액션 로그 전송 실패:', error));
}


// --- 초기화 (필요시 script.js 등에서 호출) ---
// function initUpload() {
//    // 이벤트 리스너 등록 등 초기화 작업
//    const cancelButton = document.getElementById('cancel-upload-button'); // 취소 버튼 ID 확인 필요
//    if (cancelButton) {
//        cancelButton.addEventListener('click', cancelUpload);
//    }
// }

// 전역 스코프에 필요한 함수 노출 (script.js 등 다른 파일에서 사용하기 위함)
window.startTusUpload = startTusUpload;
// window.initUpload = initUpload; // 필요하다면
// 외부 파일 드롭 처리 함수
function handleExternalFileDrop(e, targetFolderItem = null) {
    logLog('[handleExternalFileDrop] 외부 파일 드롭 처리 시작');
    
    // 드롭된 파일이 없으면 종료
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) {
        logWarn('[handleExternalFileDrop] 드롭된 파일이 없습니다.');
        return;
    }
    
    // 대상 경로 결정
    let targetPath = currentPath || '';  // 기본값은 현재 경로
    
    // 특정 폴더에 드롭된 경우 해당 폴더 경로 사용
    if (targetFolderItem && targetFolderItem.getAttribute('data-is-folder') === 'true') {
        const folderName = targetFolderItem.getAttribute('data-name');
        // '..'이 아닌 경우에만 처리
        if (folderName !== '..') {
            targetPath = targetFolderItem.getAttribute('data-path') || 
                         (currentPath ? `${currentPath}/${folderName}` : folderName);
            logLog(`[handleExternalFileDrop] 폴더에 드롭: ${targetPath}`);
        }
    }
    
    // File 객체 배열을 { file, relativePath } 형식으로 변환
    const filesWithPaths = Array.from(e.dataTransfer.files).map(file => {
        return {
            file: file,
            relativePath: file.name  // 기본적으로 파일명만 사용
        };
    });
    
    logLog(`[handleExternalFileDrop] ${filesWithPaths.length}개 파일 업로드 준비 완료, 대상 경로: ${targetPath || '루트'}`);
    
    // TUS 업로드 시작
    startTusUpload(filesWithPaths, targetPath);
}

// 전역 스코프에 노출
window.handleExternalFileDrop = handleExternalFileDrop;
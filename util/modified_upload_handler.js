// 파일 업로드 처리 (웹 UI 용 - 수정된 경로 처리 및 파일명 사용)
app.post('/api/upload', uploadMiddleware.any(), async (req, res) => {
  // targetPath: 프론트엔드에서 지정한 기본 업로드 대상 폴더 (없으면 루트)
  const targetPath = req.body.targetPath || '';
  const clientIp = getClientIp(req);

  log(`[Upload] Received multi-file upload request for base target path: '${targetPath || 'root'}' from IP: ${clientIp}`, 'info');

  if (!req.files || req.files.length === 0) {
    log('[Upload] Error: No files uploaded.', 'error');
    return res.status(400).json({ error: '파일 없음', message: '업로드할 파일이 전송되지 않았습니다.' });
  }

  log(`[Upload] Number of files received: ${req.files.length}`, 'debug');

  const results = [];
  let overallSuccess = true;

  for (const file of req.files) {
    const tempFilePath = file.path; // Multer가 저장한 임시 파일 경로
    // relativePath: 프론트엔드에서 보낸 파일의 상대 경로 (폴더 구조 포함)
    const relativePath = req.body.relativePath; // FormData에서 'relativePath' 필드 값 읽기
    const originalFilename = file.originalname; // 프론트엔드에서 FormData에 설정한 원본 파일명

    // 원본 파일명이 없거나 relativePath가 없으면 이 파일 처리 건너뛰기 (오류 가능성)
    if (!originalFilename || !relativePath) {
        log(`[Upload] Warn: Skipping file due to missing original filename or relative path. Multer fieldname: ${file.fieldname}, Originalname: ${originalFilename}, RelativePath in body: ${relativePath}`, 'warn');
        results.push({
            filename: file.fieldname, // 원래 fieldname을 식별자로 사용
            success: false,
            message: '필수 정보 누락 (원본 파일명 또는 상대 경로)',
            path: null
        });
        overallSuccess = false;
        // 오류 발생 시 임시 파일 삭제
        await fs.promises.unlink(tempFilePath).catch(unlinkError => {
            if (unlinkError.code !== 'ENOENT') {
                log(`[Upload]   Error deleting temp file for skipped file ${file.fieldname}: ${unlinkError.message}`, 'warn');
            }
        });
        continue; // 다음 파일 처리
    }


    log(`[Upload] Processing file - Original name: ${originalFilename}, Relative path: ${relativePath}`, 'debug');

    // 최종 저장 경로 구성: (기본 대상 경로) + (파일의 상대 경로)
    // path.join은 불필요한 '/'를 처리해주고 OS에 맞는 구분자 사용
    const finalRelativePath = path.normalize(path.join(targetPath, relativePath));
    const destinationPath = path.join(ROOT_DIRECTORY, finalRelativePath);
    const destinationDir = path.dirname(destinationPath);

    // 경로 정제 (불필요할 수 있으나 안전을 위해)
    const sanitizedFilename = sanitizeFilename(path.basename(finalRelativePath)); // 최종 경로의 파일명 부분만 정제
    const finalSanitizedPath = path.join(path.dirname(finalRelativePath), sanitizedFilename); // 정제된 파일명을 포함한 최종 상대 경로
    const finalDestinationPath = path.join(ROOT_DIRECTORY, finalSanitizedPath); // 정제된 최종 절대 경로
    const finalDestinationDir = path.dirname(finalDestinationPath); // 정제된 최종 디렉토리 경로

    log(`[Upload]   Base Target Path: ${targetPath || 'root'}`, 'debug');
    log(`[Upload]   Received Relative Path: ${relativePath}`, 'debug');
    log(`[Upload]   Calculated Final Relative Path: ${finalSanitizedPath}`, 'info');
    log(`[Upload]   Final Destination Directory: ${finalDestinationDir}`, 'info');
    log(`[Upload]   Final Destination Path: ${finalDestinationPath}`, 'info');
    log(`[Upload]   Temp file: ${tempFilePath}`, 'debug');

    let fileSuccess = false;
    let errorMessage = '';

    try {
      // --- 경로 및 파일명 길이 검증 (정제된 경로 기준) ---
      if (Buffer.from(finalSanitizedPath).length > MAX_PATH_BYTES) {
         throw new Error(`경로 길이 초과 (${Buffer.from(finalSanitizedPath).length} > ${MAX_PATH_BYTES} 바이트)`);
      }
      if (Buffer.from(sanitizedFilename).length > MAX_FILENAME_BYTES) {
         throw new Error(`파일명 길이 초과 (${Buffer.from(sanitizedFilename).length} > ${MAX_FILENAME_BYTES} 바이트)`);
      }
      // --- 검증 끝 ---

      // --- 목적지 디렉토리 확인 및 생성 (정제된 경로 기준) ---
      try {
          // 디렉토리 존재 여부 확인 (존재하면 OK, 파일이면 에러)
          const stats = await fs.promises.stat(finalDestinationDir);
          if (stats.isFile()) {
              throw new Error(`경로 충돌: '${path.basename(finalDestinationDir)}' 위치에 파일이 존재합니다.`);
          }
          log(`[Upload]   Destination directory exists: ${finalDestinationDir}`, 'debug');
      } catch (error) {
          // 디렉토리가 없으면 생성 (ENOENT 오류)
          if (error.code === 'ENOENT') {
              log(`[Upload]   Destination directory does not exist. Creating: ${finalDestinationDir}`, 'info');
              try {
                  await fs.promises.mkdir(finalDestinationDir, { recursive: true, mode: 0o777 });
                  log(`[Upload]   Successfully created directory: ${finalDestinationDir}`, 'info');
                  // 생성 후 다시 확인 (매우 드문 경우지만, 생성 직후 접근 불가 등 확인)
                  try {
                      const createdStat = await fs.promises.stat(finalDestinationDir);
                      if (!createdStat.isDirectory()) {
                           throw new Error(`폴더 생성 오류: '${path.basename(finalDestinationDir)}' 생성 후 파일로 확인됨.`);
                      }
                  } catch (verifyError) {
                      throw new Error(`폴더 생성 확인 오류: ${verifyError.message}`);
                  }
              } catch (mkdirError) {
                  log(`[Upload]   Error during mkdir for ${finalDestinationDir}: ${mkdirError.message}`, 'error');
                  // EEXIST는 이론상 mkdir recursive:true 에서 발생하면 안되지만, 동시성 문제 등 대비
                  if (mkdirError.code === 'EEXIST') {
                       try {
                           const finalStat = await fs.promises.stat(finalDestinationDir);
                           if (finalStat.isFile()){ throw new Error(`경로 충돌: 파일 발견.`); }
                           // 디렉토리면 무시하고 진행
                       } catch(finalStatErr) {
                           throw new Error(`디렉토리 상태 확인 오류 (EEXIST 후): ${finalStatErr.message}`);
                       }
                   } else {
                      throw new Error(`디렉토리 생성 실패: '${path.basename(finalDestinationDir)}'. 오류: ${mkdirError.message}`);
                   }
              }
          } else {
              // 그 외 stat 오류 (권한 등)
              log(`[Upload]   Error checking destination directory ${finalDestinationDir}: ${error.message}`, 'error');
              throw new Error(`서버 오류: 업로드 대상 폴더 확인 중 오류 발생 (${error.code})`);
          }
      }
      // --- 디렉토리 확인 및 생성 끝 ---

      // --- 최종 파일 경로 충돌 확인 (정제된 경로 기준) ---
      try {
        await fs.promises.access(finalDestinationPath);
        // 파일이 이미 존재하면 충돌 오류 발생
        throw new Error(`파일 충돌: '${sanitizedFilename}' 파일이 이미 대상 폴더에 존재합니다.`);
      } catch (error) {
        // ENOENT (파일 없음) 오류는 정상적인 경우이므로 무시
        if (error.code !== 'ENOENT') {
          log(`[Upload]   Error checking destination file path ${finalDestinationPath}: ${error.message}`, 'error');
          throw new Error(`서버 오류: 업로드 파일 경로 확인 중 오류 발생 (${error.code})`);
        }
        // 파일이 없으므로 진행 가능
        log(`[Upload]   Destination path is clear: ${finalDestinationPath}`, 'debug');
      }
      // --- 최종 파일 경로 충돌 확인 끝 ---

      // 임시 파일을 최종 목적지로 이동
      await fs.promises.rename(tempFilePath, finalDestinationPath);
      log(`[Upload] File moved: Temp(${tempFilePath}) -> Final(${finalDestinationPath})`, 'info');
      fileSuccess = true;

    } catch (error) {
      // 개별 파일 처리 오류
      log(`[Upload] Error processing file ${originalFilename} (relative: ${relativePath}): ${error.message}\nStack: ${error.stack}`, 'error');
      errorMessage = error.message || '파일 처리 중 오류 발생';
      overallSuccess = false;
      // 오류 발생 시 임시 파일 삭제
      await fs.promises.unlink(tempFilePath).catch(unlinkError => {
          if (unlinkError.code !== 'ENOENT') { // 파일이 이미 없어진 경우는 무시
              log(`[Upload]   Warn: Error deleting temp file ${tempFilePath} after error: ${unlinkError.message}`, 'warn');
          }
      });
    }

    results.push({
        filename: originalFilename, // 사용자에게 보여줄 원본 파일명
        success: fileSuccess,
        message: fileSuccess ? '업로드 성공' : errorMessage,
        path: fileSuccess ? finalSanitizedPath : null // 성공 시 저장된 최종 상대 경로
    });
  } // End of for loop

  // 모든 파일 처리 후 디스크 사용량 업데이트
  updateDiskUsage();

  // 최종 응답 결정
  if (overallSuccess) {
    log(`[Upload] All ${req.files.length} files uploaded successfully to base path: '${targetPath || 'root'}'`, 'minimal');
    res.status(201).json({ success: true, message: `${req.files.length}개 파일 업로드 성공`, results: results });
  } else {
    const failedCount = results.filter(r => !r.success).length;
    const successCount = req.files.length - failedCount;
    log(`[Upload] Upload completed with errors for base path: '${targetPath || 'root'}'. Success: ${successCount}, Failed: ${failedCount}.`, 'warn');
    // 207 Multi-Status: 일부 성공, 일부 실패 시
    res.status(207).json({ success: false, message: `파일 업로드 완료 (${successCount} 성공, ${failedCount} 실패)`, results: results });
  }
}); 
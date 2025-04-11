#!/usr/bin/env python3
import sys
import os

def remove_lines(file_path, ranges, target_file):
    # 안전장치: 지정된 파일만 처리
    if os.path.abspath(file_path) != target_file:
        print(f"오류: 이 스크립트는 '{target_file}' 파일에 대해서만 사용할 수 있습니다.")
        print(f"      제공된 파일: '{os.path.abspath(file_path)}'")
        return False
    
    with open(file_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # 원본 파일 백업
    with open(file_path + '.bak', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    # 역순으로 정렬된 범위에서 지정된 행 삭제
    for start, end in ranges:
        del lines[start-1:end]
    
    # 수정된 내용 저장
    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    print(f"삭제 완료. 총 {len(ranges)}개 블록 제거됨")
    return True

# 이 스크립트가 대상으로 하는 파일 경로
TARGET_FILE = "/home/purestory/webdav/backend/tus-server.js"

# 삭제할 행 범위 (시작행, 끝행)
ranges = [
]

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"사용법: {sys.argv[0]} <파일_경로>")
        print(f"참고: 이 스크립트는 '{TARGET_FILE}' 파일의 중복 함수를 제거하기 위해 생성되었습니다.")
        sys.exit(1)
    
    js_file = sys.argv[1]
    
    if remove_lines(js_file, ranges, TARGET_FILE):
        print(f"'{js_file}' 파일의 중복 함수 제거 완료")
    else:
        print("작업이 중단되었습니다.")

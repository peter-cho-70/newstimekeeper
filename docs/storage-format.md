## 로컬 저장 포맷(초안, JSON)

### 1) 목표
- 웹 MVP에서 **단일 사용자**가 큐시트/템플릿을 파일로 저장하고 재사용할 수 있어야 한다.
- 내부 계산은 **초 단위(정수)**로 저장하여 계산을 단순/안정화한다.

### 2) 파일 종류
- **템플릿 파일**: 프로그램별 기본 아이템/기본 길이/기본 아이템 표시 규칙 포함
- **큐시트(세션) 파일**: 특정 방송일/회차의 편집 결과(템플릿 기반 + 사용자 수정) 저장

### 3) 공통 필드
- `schemaVersion`: 향후 호환을 위한 버전 문자열(예: `"1.0"`)
- `createdAt`, `updatedAt`: ISO8601

---

## 4) Template JSON

```json
{
  "schemaVersion": "1.0",
  "type": "template",
  "programId": "news_extra",
  "programName": "뉴스외전",
  "createdAt": "2026-05-28T00:00:00Z",
  "updatedAt": "2026-05-28T00:00:00Z",
  "defaults": {
    "scheduledSeconds": 3060,
    "newsStartTime": "20:00:00"
  },
  "items": [
    {
      "id": "t1",
      "kind": "sectionHeader",
      "title": "오프닝",
      "includeInRun": false
    },
    {
      "id": "t2",
      "kind": "newsItem",
      "category": "기타",
      "reporter": "",
      "title": "타이틀",
      "durationSeconds": 20,
      "notes": "",
      "isDefaultItem": true,
      "includeInRun": true,
      "flags": []
    },
    {
      "id": "t3",
      "kind": "marker",
      "title": "뉴스끝",
      "includeInRun": false
    }
  ]
}
```

### 필드 정의(템플릿)
- `programId`: 내부 식별자(슬러그 권장)
- `defaults.scheduledSeconds`: 기본 편성시간(초)
- `defaults.newsStartTime`: 기본 뉴스 시작시간(문자열 `HH:MM:SS`)
- `items[].kind`
  - `newsItem`: 실제 진행 아이템
  - `blank`: 빈 줄(구분용)
  - `sectionHeader`: 섹션 헤더(오프닝/앵커 블록 등)
  - `marker`: 특수 마커(예: 뉴스끝)
- `includeInRun`: 합산/시작시각 계산 포함 여부
- `isDefaultItem`: “기본 아이템” 표시용
- `flags`: `["V","A","C"]` 같은 태그(의미는 설정으로 확장 가능)

---

## 5) Rundown(큐시트 세션) JSON

```json
{
  "schemaVersion": "1.0",
  "type": "rundown",
  "programId": "news_extra",
  "programName": "뉴스외전",
  "broadcastDate": "2026-05-28",
  "episodeLabel": "",
  "createdAt": "2026-05-28T00:00:00Z",
  "updatedAt": "2026-05-28T00:00:00Z",
  "timing": {
    "newsStartTime": "20:00:00",
    "scheduledSeconds": 3060,
    "toleranceSeconds": 15
  },
  "items": [
    {
      "id": "i1",
      "kind": "newsItem",
      "category": "완제",
      "reporter": "김민찬",
      "title": "[N/D] 드루킹 ...",
      "durationSeconds": 161,
      "notes": "",
      "isDefaultItem": false,
      "includeInRun": true,
      "flags": ["V"]
    },
    {
      "id": "m_end",
      "kind": "marker",
      "title": "뉴스끝",
      "includeInRun": false
    },
    {
      "id": "i_after_end_1",
      "kind": "newsItem",
      "category": "단신",
      "reporter": "",
      "title": "예비 아이템",
      "durationSeconds": 20,
      "notes": "",
      "isDefaultItem": false,
      "includeInRun": false,
      "flags": []
    }
  ]
}
```

### 필드 정의(큐시트)
- `timing.toleranceSeconds`: “편성대비 오차범위” 목표(기본 15초)
- `items[]`는 UI의 행 순서를 그대로 저장한다(위/아래 이동=배열 재정렬).

---

## 6) 호환/마이그레이션 원칙
- 파싱 실패 대비: 알 수 없는 필드는 무시(Forward compatible)
- `schemaVersion`이 다르면 마이그레이션 단계에서 변환


# `.mcpb` 사내 설치 테스트 — 절차와 기록지

작성: 2026-09-11 · 대상: 사내 PC(Claude Desktop 설치본) · 소요: 약 30분

채널 비교 문서 7절의 **"시작 전 30분 테스트"**를 실제로 돌리기 위한 도구와 절차다. 조사 환경이 사외망이라 여기서는 검증할 수 없고, **사내 PC에서만 답이 나오는 항목들**을 한 번에 확인하도록 만들었다.

---

## 0. 왜 이걸 먼저 하나

채널 비교 문서의 잠정 권고는 **로컬 stdio MCP + `.mcpb` 데스크톱 확장**이다. 이 경로는 두 가지 전제 위에 서 있다.

1. 조직 정책이 `.mcpb` 설치를 막지 않는다
2. 사용자 PC에서 실행되는 서버 프로세스가 사내 TX360에 직접 닿는다

**둘 중 하나라도 깨지면 권고 자체가 바뀐다.** 설계를 더 진행하기 전에 확인해야 하는 이유다.

### 용어 — `.mcpb`

- **정의**: MCP 서버 코드와 `manifest.json`을 한 덩어리로 묶은 zip 파일. 확장자만 다르다 `[검증됨]`
- **비유**: 크롬 확장(`.crx`)이나 VS Code 확장(`.vsix`)과 같은 개념. 더블클릭으로 설치한다
- **이건 아님**: 원격 서버에 접속하는 "커넥터"가 아니다. 코드가 **사용자 PC에서 실행된다**

---

## 1. 준비물

| 항목 | 내용 |
|---|---|
| 파일 | `tools/mcpb-install-probe.mcpb` (약 12 KB) |
| 반입 | 사외망 → 사내망 파일 반입 절차를 거쳐야 한다. **이게 첫 번째 관문이다** |
| 사전 정보 | 사내 TX360 호스트명과 포트 (설치 시 입력. 파일에 하드코딩돼 있지 않다) |

**외부 의존성이 없다.** Node 내장 모듈만 쓰므로 사내에서 `npm install`을 할 필요가 없다. Claude Desktop이 macOS·Windows에 Node를 동봉하므로 PC에 Node가 없어도 된다 `[검증됨]`.

**외부로 아무것도 보내지 않는다.** 입력한 호스트명은 로컬 진단에만 쓰이고, sensitive 필드 값은 어떤 출력에도 찍히지 않는다.

---

## 2. 실행 절차

1. `.mcpb` 파일을 더블클릭하거나 **Claude Desktop → 설정 → 확장 → 확장 설치**로 연다
2. 설정 폼에 **대상 호스트 / 포트 / 경로**를 입력한다. `보안 저장 테스트 값`에는 아무 문자열이나 넣는다
3. 설치 후 새 대화에서 `probe_report`를 실행시킨다 (예: *"probe_report 도구 돌려 줘"*)
4. 이어서 `probe_network`를 실행시킨다
5. 결과 아래 **패널이 그려지면** 패널의 버튼을 위에서부터 순서대로 눌러 본다
6. 마지막으로 모델에게 *"지금 쓸 수 있는 도구를 전부 나열해 줘"*라고 물어본다

---

## 3. 기록지 — 결과를 여기에 적는다

### 3-1. 설치 (가장 중요)

| # | 확인 | 결과 | 메모 |
|---|---|---|---|
| 1 | 파일이 사내망으로 반입되는가 | ☐ 예 ☐ 아니오 | |
| 2 | 설치가 시작되는가 (정책 차단 없음) | ☐ 예 ☐ 아니오 | |
| 3 | 설정 폼(4개 필드)이 뜨는가 | ☐ 예 ☐ 아니오 | |
| 4 | `보안 저장 테스트 값`이 마스킹되는가 | ☐ 예 ☐ 아니오 | |
| 5 | 서버가 기동되어 도구가 보이는가 | ☐ 예 ☐ 아니오 | |

> ⚠️ **2번이 아니오면 로컬 stdio 경로 전체가 탈락한다.** 그 경우 MCP 터널이 유일한 대안이 되고, 이는 Enterprise 신청 절차를 타야 한다.

### 3-2. `probe_report` 출력에서 옮겨 적을 것

| 항목 | 값 |
|---|---|
| Node 버전 / 실행 경로 | |
| → 동봉 Node인가 시스템 Node인가 | ☐ 동봉 ☐ 시스템 |
| 협상된 프로토콜 버전 | |
| **MCP Apps 확장 광고 여부** | ☐ 예 ☐ 아니오 |
| sensitive 값 전달됨 | ☐ 예 ☐ 아니오 |
| `HTTPS_PROXY` 설정돼 있나 | |
| `NODE_EXTRA_CA_CERTS` 설정돼 있나 | |

### 3-3. `probe_network` 판정

| 단계 | 결과 | 소요 | 비고 |
|---|---|---|---|
| DNS | ☐ ✅ ☐ ❌ | | 주소: |
| TCP | ☐ ✅ ☐ ❌ | | |
| TLS (검증) | ☐ ✅ ☐ ❌ | | 발급자 CN: |
| HTTPS GET | ☐ ✅ ☐ ❌ | | 상태 코드: |

**판정 해석**

| 결과 | 의미 | 다음 행동 |
|---|---|---|
| 전부 ✅ | 로컬 서버가 TX360에 직접 닿는다 | **터널 불필요.** 권고안대로 진행 |
| DNS ❌ | PC가 사내 DNS를 안 보거나 호스트명이 다름 | 호스트명 재확인, VPN 상태 확인 |
| DNS ✅ · TCP ❌ | 방화벽·네트워크 세그먼트 차단 | 네트워크팀 문의 필요 |
| TCP ✅ · TLS 검증만 ❌ | 사내 사설 CA / 프록시 개입 | `NODE_EXTRA_CA_CERTS`로 사내 CA 주입. **해결 가능한 문제다** |

### 3-4. MCP Apps (`ui://`) — 패널

| # | 확인 | 결과 | 메모 |
|---|---|---|---|
| 6 | **패널이 화면에 그려지는가** | ☐ 예 ☐ 아니오 | |
| 7 | 핸드셰이크 성공 — 어느 메서드로? | ☐ `ui/initialize` ☐ `initialize` ☐ 실패 | |
| 8 | 호스트 테마 변수를 받았는가 | ☐ 예 ☐ 아니오 | 개수: |
| 9 | `probe_report` 버튼 — UI에서 `tools/call` | ☐ ✅ ☐ ❌ | |
| 10 | `resources/read` 버튼 | ☐ ✅ ☐ ❌ | |
| 11 | 전체화면 요청 | ☐ ✅ ☐ ❌ | 실제 모드: |
| 12 | 외부 링크 열기 (`ui/open-link`) | ☐ ✅ ☐ ❌ | 브라우저가 떴나: |
| 13 | 모델 컨텍스트 주입 | ☐ ✅ ☐ ❌ | 모델이 읽었나: |
| 14 | **사내망 직접 fetch** (CSP `connectDomains`) | ☐ ✅ ☐ ❌ | |
| 15 | 모델의 도구 목록에 `probe_app_only`가 **안 보이는가** | ☐ 안 보임(정상) ☐ 보임 | |

> **14번이 이 테스트에서 가장 불확실한 항목이다.** 채널 비교 문서 5절의 `[미검증]` 항목 — "스펙상 사내망 오리진을 선언하면 사용자 브라우저가 직접 가져오므로 클라우드를 안 거친다"가 Claude 구현에서도 참인지를 여기서 판가름한다.
>
> ✅면 **사내 문서의 이미지·미리보기를 클라우드 경유 없이 대화 안에 띄울 수 있다.** 보안 심의에서 크게 유리해진다.

### 3-5. 그 외 기록할 것

- Claude Desktop 버전:
- OS / 버전:
- 설치 중 뜬 경고·오류 메시지 원문:

---

## 4. 프로브가 무엇을 하는지

`tools/mcpb-install-probe/`에 전체 소스가 있다. 심의 요청 시 그대로 제출할 수 있도록 의존성 없이 한 파일로 썼다.

| 도구 | 하는 일 |
|---|---|
| `probe_report` | 런타임·프로토콜·MCP Apps 협상·user_config 전달·프록시 환경변수 보고 |
| `probe_network` | DNS → TCP → TLS → HTTPS 단계별 검사. TLS는 검증 성공/실패를 나눠 봐서 "못 닿음"과 "인증서 불신"을 구분 |
| `probe_app_only` | `visibility: ["app"]`. 모델 도구 목록에서 숨겨지는지 확인용 |
| `ui://.../panel` | 위 항목 6~14를 버튼으로 확인하는 패널 |

**설계상 지킨 것**

- 사내 호스트명을 번들에 넣지 않는다. 설치 시 입력받아 런타임에만 쓴다
- sensitive 필드는 **전달 여부만** 출력하고 값은 절대 찍지 않는다
- 네트워크 요청은 사용자가 입력한 호스트로만 나간다. 외부 전송 경로가 없다

---

## 5. 근거

| 내용 | 등급 | 출처 |
|---|---|---|
| `.mcpb`는 `manifest.json` + 서버 코드를 담은 zip | `[검증됨]` | [mcpb README](https://github.com/modelcontextprotocol/mcpb) |
| manifest 스키마 `0.3`, `${__dirname}`·`${user_config.KEY}` 치환, `sensitive` 보안 저장 | `[검증됨]` | [MANIFEST.md](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) |
| **Node.js가 macOS·Windows용 Claude에 동봉된다** | `[검증됨]` | [mcpb README](https://github.com/modelcontextprotocol/mcpb) |
| MCP Apps 확장 식별자 `io.modelcontextprotocol/ui`, `mimeTypes` 필수 | `[검증됨]` | [ext-apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) |
| 뷰가 쓸 수 있는 메시지 — `tools/call`·`resources/read`·`ui/open-link`·`ui/request-display-mode`·`ui/update-model-context`, 표시 모드 3종 | `[검증됨]` | 동일 |
| `visibility: ["app"]` 도구는 모델 도구 목록에서 제외해야 한다 (호스트 MUST) | `[검증됨]` | 동일 |
| 기본 CSP는 `default-src 'none'`, `resourceDomains`·`connectDomains` 선언 시에만 열린다 | `[검증됨]` | 동일 |
| Claude Desktop이 MCP Apps 지원 호스트로 등재 | `[검증됨]` | [client-matrix.mdx](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx) |
| 프로브가 프로토콜 수준에서 정상 동작 | `[검증됨]` | 이 조사에서 stdio 하네스로 직접 실행 — initialize·tools/list·resources/read·3개 도구 모두 확인 |

---

## 이 문서의 한계

1. **프로브는 사외망에서만 검증됐다.** JSON-RPC 왕복과 도구 동작은 확인했지만, **Claude Desktop 실물에 설치해 보지는 못했다.** 설치 단계에서 예상 못 한 거부가 날 수 있다.
2. **스펙 기준으로 만들었지 Claude 구현 기준이 아니다.** 특히 패널의 핸드셰이크는 스펙 본문(`ui/initialize`)과 예제(`initialize`)가 어긋나 있어 **양쪽 다 시도**하도록 짰다. 어느 쪽이 먹히는지가 곧 결과다.
3. **반입 절차 자체를 확인하지 못했다.** 사외망에서 만든 실행 가능 파일이 사내로 들어갈 수 있는지는 별개 문제다. 막히면 소스를 사내에서 직접 재작성해야 한다 (`tools/mcpb-install-probe/`에 전문이 있다).
4. **`probe_network`의 TLS 검증 생략 시도**는 "도달은 하는데 인증서 불신"을 구분하려는 **진단 목적**이다. 실제 서버 구현에 이 방식을 쓰면 안 된다.
5. **Linux는 Node 동봉 대상이 아니다.** 확인된 문장은 macOS·Windows만 말한다. Linux 데스크톱이면 PC에 Node가 있어야 한다.
6. **항목 15(app-only 도구 숨김)는 호스트 구현에 달렸다.** 스펙은 MUST라고 하지만 실제로 그런지는 눈으로 봐야 한다.

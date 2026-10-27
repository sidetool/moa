# 공통 컴포넌트

`apps/web/src/components/ui`에서 가져옵니다. 아래 미리보기는 앱과 같은 컴포넌트·스타일을 사용합니다.

## 버튼

`Button`은 `secondary`·`primary`·`ghost`·`accent`, `m`·`l` 크기, 아이콘, 표준 버튼 속성과 `ref`를 지원합니다. 최소 높이는 40px이며 `l`은 48px입니다. 폼에서는 `type`을 지정하고 저장 중에는 `disabled`·`aria-busy`를 사용합니다.

`ButtonLink`는 앱 내부 경로로 이동합니다. `IconButton`에는 이름을 알리는 `label`이 필요합니다. 값 선택에는 `SegmentedControl`을 사용합니다.

```tsx
import { Button, IconButton } from '../../components/ui';
<Button type="submit" variant="primary" disabled={saving} aria-busy={saving}>저장</Button>
```

```preview
buttons
```

## 선택 버튼

`SegmentedControl<T extends string>`은 `value`, `options(value/label)`, `onChange`, `label`과 선택적 `disabled`·`className`을 받습니다. 방향키·Home·End로 선택과 포커스를 함께 옮깁니다. 오른쪽부터 읽는 화면에서는 좌우 방향을 바꿉니다. 잘못된 값에는 선택 배경을 표시하지 않으며, 모션 감소 설정에서는 배경을 즉시 옮깁니다.

```tsx
<SegmentedControl label="목록 정렬" value={sort}
  options={[{ value: 'popular', label: '인기' }, { value: 'latest', label: '최신' }]}
  onChange={setSort} />
```

```preview
segmented
```

## 입력

일반 입력은 `label.field`와 `input.input`으로 구성합니다. 이름·형식·자동 완성·필수 여부를 지정하고, 오류는 `aria-invalid`와 연결된 설명으로 알립니다.

`PasswordInput`은 표준 입력 속성과 `revealLabel`을 받습니다. 표시 버튼의 상태는 `aria-pressed`에 반영되며, `disabled`는 입력과 버튼 모두에 적용됩니다. 비밀번호 저장·전송은 기능 화면이 담당합니다.

```preview
fields
```

## 드롭다운

`Select`는 `options(value/label)`, `value`, `onChange`, 표준 버튼 속성을 받습니다. `multiple=true`에서는 값과 변경 결과가 문자열 배열입니다. `aria-label` 또는 `aria-labelledby`로 이름을 연결합니다.

단일 선택은 선택 후 닫히고 다중 선택은 열린 채 변경됩니다. Tab·Escape로 닫고 방향키·Home·End·Enter·Space와 글자 검색을 지원합니다. 선택 후 포커스는 열기 버튼으로 돌아옵니다.

최소 높이는 40px입니다. 긴 값은 버튼에서 말줄임하고 목록에서는 줄바꿈합니다. 목록은 화면 안에 배치하고 내부 스크롤을 사용합니다. Popover를 지원하지 않는 브라우저에서는 기본 `select`를 사용합니다. 비활성화된 다중 선택은 읽기만 가능합니다.

```preview
select
```

## 토글과 체크박스

`Toggle`은 `checked`, `onChange`, `label`, `disabled`를 받으며 Space·Enter로 바꿉니다. 다중 목록은 기본 `input type=checkbox`를 사용합니다. 체크 모양과 색상으로 상태를 알리고, 작은 체크박스도 넓은 `label` 영역에서 누를 수 있게 합니다.

```preview
toggle
```

## 확인 모달

`ConfirmDialog`은 `title`, `children`, `onClose`와 선택적 `onConfirm`, `confirmLabel`, `busy`, `confirmDisabled`, `className`을 받습니다. 기본 `dialog`로 포커스를 제한하고 취소에 처음 포커스를 둡니다. 닫히면 열었던 요소로 돌아갑니다.

`busy` 동안 확인·취소·바깥 클릭·Escape를 막습니다. 실제 요청과 오류 처리는 기능 화면이 담당하며, 확인 동작이 없으면 닫기만 표시합니다.

```preview
confirmation
```

## 로딩과 빈 화면

- `Spinner(size)`는 로딩 상태 이름을 제공합니다.
- `Skeleton(className/style)`은 장식용 로딩 영역입니다.
- `ProgressBar(ratio)`는 진행 표시이며 작업 이름·수치는 호출자가 제공합니다.
- `EmptyState(icon/title/body/action)`는 빈 결과와 다음 동작을 보여 줍니다.
- `ScrollLoader(hasMore/loading/failed/onLoad)`는 추가 목록을 불러오며 실패 후 반복 요청하지 않습니다.

```preview
feedback
```

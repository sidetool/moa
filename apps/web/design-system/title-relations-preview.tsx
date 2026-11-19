import { MemoryRouter, useLocation } from "react-router-dom";
import { RelatedWorkSection } from "../src/features/title/TitleWorks";

function Destination() {
  const { pathname, search } = useLocation();
  const label = pathname.startsWith("/title/") ? "첫 상영 상세" : new URLSearchParams(search).get("q");
  return <output>{label && (search ? `‘${label}’ 검색 결과` : label)}</output>;
}

export function TitleRelationsPreview() {
  return <MemoryRouter>
    <RelatedWorkSection items={[
      { key: "prequel", relation: "prequel", title: "첫 상영", year: 2024, mediaId: "first-screening", query: "첫 상영" },
      { key: "side-story", relation: "sideStory", title: "영사실의 밤", year: 2025, query: "영사실의 밤" },
    ]} />
    <Destination />
  </MemoryRouter>;
}

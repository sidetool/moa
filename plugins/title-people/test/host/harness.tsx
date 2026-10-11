// Renders MOA's real title-page cast row and people sheet with a fake `title.people` source. Synthetic data only.
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Person } from "@moa/shared";
import { PeopleRow } from "../../../../apps/web/src/components/TitleExtras";
import { registerPeopleHook, type PeopleRequest } from "../../../../apps/web/src/lib/people-hooks";
import "../../../../apps/web/src/styles/base.css";
import "../../../../apps/web/src/styles/components.css";
import "../../../../apps/web/src/styles/pages.css";

type Pending = { value: PeopleRequest; resolve: (value: unknown) => void; reject: (error: Error) => void; aborted: boolean };
const pending: Pending[] = [];
let unregister: (() => void) | null = null;

const people: Person[] = [
  { name: "배우 하나", role: "주인공", photo: "https://image.tmdb.org/t/p/w185/actor1.jpg", identity: { provider: "tmdb", id: "0042" } },
  { name: "배우 둘", role: "조연", identity: { provider: "tmdb", id: "7" } },
  { name: "오래된 캐시", role: "식별자 없음" },
  { name: "다른 출처", role: "지원 안 함", identity: { provider: "example", id: "1" } },
];

function Where() {
  const location = useLocation();
  return <output id="location" hidden>{location.pathname + location.search}</output>;
}

let config: { people: Person[]; linked: boolean } = { people, linked: true };
function Title() {
  return <div className="title-page"><div className="title-body"><PeopleRow key="m1" people={config.people} mediaId="m1" linked={config.linked} /></div></div>;
}

Object.assign(window, {
  pending,
  register(profile = "p1") {
    unregister?.();
    unregister = registerPeopleHook("title-people", { profile, name: "출연·제작진", run: (value, signal) => new Promise((resolve, reject) => {
      const entry: Pending = { value, resolve, reject, aborted: false };
      signal.addEventListener("abort", () => { entry.aborted = true; reject(new Error("aborted")); }, { once: true });
      pending.push(entry);
    }) });
  },
  unregister() { unregister?.(); unregister = null; },
  answer(index: number, value: unknown) { pending[index].resolve(value); },
  fail(index: number) { pending[index].reject(new Error("failed")); },
});

localStorage.setItem("moa.profile", "p1");
const root = createRoot(document.getElementById("root")!);
let mounts = 0;
(window as any).mount = (next?: { people?: Person[]; linked?: boolean }) => {
  config = { people: next?.people ?? people, linked: next?.linked ?? true };
  root.render(
  <MemoryRouter key={++mounts} initialEntries={["/title/m1"]}>
    <Where />
    <Routes><Route path="/title/:id" element={<Title />} /><Route path="*" element={<p>search page</p>} /></Routes>
  </MemoryRouter>
  );
};

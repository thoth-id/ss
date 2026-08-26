import { evalJS } from "./cdp.ts";

export type TileInfo = {
	id?: string;
	x: number;
	y: number;
	w: number;
	h: number;
	peer: boolean;
	outOfStage: boolean;
	overDock: boolean;
	overTop: boolean;
	vw: number;
	vh: number;
};

export type MeasureInfo = {
	scrolls: boolean;
	scrollH: number;
	innerH: number;
	stage: { w: number; h: number };
	tiles: TileInfo[];
	tileNames: (string | null)[];
	pills: boolean[];
	gate: boolean;
	goOff: boolean;
	myId: string | null;
	topBar: string[];
};

// the fit transitions left/top/width/height over .16s. measuring two rAFs
// later reads geometry in flight: a tile off its aspect ratio, a pill still in
// its old place. wait twice the transition.
export const settle = (): Promise<void> => Bun.sleep(340);

export async function measure(): Promise<MeasureInfo> {
	return await evalJS<MeasureInfo>(`(() => {
    const st = document.getElementById("stage").getBoundingClientRect();
    const dock = document.querySelector(".dock").getBoundingClientRect();
    const topBar = document.querySelector(".top").getBoundingClientRect();
    const overlaps = (r, o) =>
      !(r.right <= o.left || r.left >= o.right || r.bottom <= o.top || r.top >= o.bottom);
    const tiles = [...document.querySelectorAll(".tile")].map((t) => {
      const r = t.getBoundingClientRect();
      const v = t.querySelector("video");
      return { id: t.dataset.id, x: r.x, y: r.y, w: r.width, h: r.height,
               peer: t.classList.contains("peer"),
               outOfStage: r.bottom > st.bottom + 1 || r.right > st.right + 1 || r.top < st.top - 1,
               overDock: overlaps(r, dock), overTop: overlaps(r, topBar),
               vw: v ? v.getBoundingClientRect().width : 0,
               vh: v ? v.getBoundingClientRect().height : 0 };
    });
    return {
      scrolls: document.documentElement.scrollHeight > innerHeight,
      scrollH: document.documentElement.scrollHeight, innerH: innerHeight,
      stage: { w: st.width, h: st.height },
      tiles,
      tileNames: [...document.querySelectorAll(".tile .who b")].map((b) => b.textContent),
      // the two pills share the tile's bottom edge. overlapping is the way
      // this fails, and it is measurable: compare boxes, not class names.
      pills: [...document.querySelectorAll(".tile:not(.peer)")].map((t) => {
        const whoRect = t.querySelector(".who").getBoundingClientRect();
        const tel = t.querySelector(".tel");
        if (getComputedStyle(tel).display === "none") return true;
        return whoRect.right <= tel.getBoundingClientRect().left;
      }),
      gate: !document.getElementById("gate").hidden,
      goOff: document.getElementById("gateGo").disabled,
      myId: typeof myId !== "undefined" ? myId : null,
      topBar: [...document.querySelectorAll(".top span")].filter((s) => !s.hidden).map((s) => s.textContent),
    };
  })()`);
}

export function allInside(m: MeasureInfo): boolean {
	return m.tiles.every((t) => !t.outOfStage && !t.overDock && !t.overTop) && m.pills.every(Boolean);
}

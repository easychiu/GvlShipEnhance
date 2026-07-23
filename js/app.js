(() => {
  "use strict";

  const D = window.GAME_DATA;
  const ATTRS = D.attrs;
  const PARTS = D.parts;
  const SHIPS = D.ships;
  const SHORT = D.shortNames;
  const COLORS = D.attrColors;
  const SLOTS = D.slotsPerRound;
  const PRESET_KEY = "gvlShip_presets_v1";
  const HELP_KEY = "gvlShip_hasSeenHelp";
  const THEME_KEY = "gvlShip_theme";

  /** @type {{ parts: (string|number)[], values: Record<string, number>, locks: Record<string, boolean>, note: string }[]} */
  let rounds = [];
  let filterAttr = null;
  /** 材料遮罩：選中的屬性（有任一加成即顯示）；空 = 不遮罩 */
  let partMaskAttrs = new Set();
  let cumulativeMode = true; // true=累計顯示總值, false=拆分顯示本輪增量
  let autoFill = true;
  let showAllAttrs = true;
  let maxLimit = Object.fromEntries(ATTRS.map((a) => [a, ""]));
  /** 自動配優先順序：數字愈小愈優先（1 最高）；空白 = 不列入自動配 */
  let attrPriority = Object.fromEntries(ATTRS.map((a) => [a, ""]));
  /** 強化次數上限（可強化總輪數） */
  let maxEnhanceCount = "";
  /** 目前套用的船隻鍵 type|name，空字串表示手動 */
  let selectedShipKey = "";
  let sourceTrace = { attr: null, global: false, ri: null };
  let floatVisible = false;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function emptyRound() {
    return {
      parts: Array(SLOTS).fill(""),
      values: Object.fromEntries(ATTRS.map((a) => [a, 0])),
      locks: Object.fromEntries(ATTRS.map((a) => [a, false])),
      note: "",
    };
  }

  function partBonus(partId) {
    const p = PARTS[String(partId)];
    return p ? p.bonus : null;
  }

  function roundPartCap(round) {
    const cap = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    for (const id of round.parts) {
      if (!id) continue;
      const b = partBonus(id);
      if (!b) continue;
      for (const a of ATTRS) cap[a] += b[a] || 0;
    }
    return cap;
  }

  /** 屬性是否有設定有效上限 */
  function getAttrLimit(attr) {
    if (maxLimit[attr] === "" || maxLimit[attr] == null) return null;
    const lim = Number(maxLimit[attr]);
    if (!Number.isFinite(lim) || lim < 0) return null;
    return lim;
  }

  /**
   * 強化規則：目前累計 < 上限 → 本輪仍可強化（可一次加滿零件加成、允許超限）
   * 目前累計 ≥ 上限 → 本輪起不可再強化該屬性
   */
  function canEnhanceAttr(currentTotal, attr) {
    const lim = getAttrLimit(attr);
    if (lim == null) return true;
    return (currentTotal || 0) < lim;
  }

  function prevTotalsBefore(roundIndex) {
    if (roundIndex <= 0) {
      return Object.fromEntries(ATTRS.map((a) => [a, 0]));
    }
    return totalsAtRound(roundIndex - 1);
  }

  function autoFillRound(roundIndex) {
    const round = rounds[roundIndex];
    // 未選滿 4 零件時不改寫數值，保留使用者原本的強化素質
    if (!isPartsComplete(round)) return;
    const cap = roundPartCap(round);
    const prev = prevTotalsBefore(roundIndex);
    // 拆分模式：本輪增量 = 可強化屬性的零件上限加總
    // 累計模式：本輪總值 = 前輪總值 + 可強化增量
    for (const a of ATTRS) {
      if (round.locks[a]) continue;
      const can = canEnhanceAttr(prev[a] || 0, a);
      const delta = can ? cap[a] || 0 : 0;
      if (cumulativeMode) {
        round.values[a] = (prev[a] || 0) + delta;
      } else {
        round.values[a] = delta;
      }
    }
  }

  /** 有填有效優先數字才參與自動配（空白 = 不列入） */
  function getAutoPriority(attr) {
    const raw = attrPriority[attr];
    if (raw === "" || raw == null) return null;
    const p = Number(raw);
    if (!Number.isFinite(p) || p <= 0) return null;
    return p;
  }

  function isAutoAllocTarget(attr) {
    return getAttrLimit(attr) != null && getAutoPriority(attr) != null;
  }

  function priorityWeight(attr) {
    const p = getAutoPriority(attr);
    if (p == null) return 0;
    return 1 / p;
  }

  /** 本輪是否已選滿 4 個不重複零件 */
  function isPartsComplete(round) {
    if (!round || !Array.isArray(round.parts)) return false;
    const filled = round.parts.filter((p) => p !== "" && p != null);
    if (filled.length !== SLOTS) return false;
    return new Set(filled.map(String)).size === SLOTS;
  }

  function countFilledParts(round) {
    return (round?.parts || []).filter((p) => p !== "" && p != null).length;
  }

  /** 純帆（槳力上限 0）：無槳可選、雷達六邊形 */
  function isPureSailProfile() {
    return getAttrLimit("槳力") === 0;
  }

  /** 介面／自動配可見屬性（純帆不含槳力） */
  function uiAttrs() {
    if (isPureSailProfile()) return ATTRS.filter((a) => a !== "槳力");
    return ATTRS.slice();
  }

  function chartAttrs() {
    return uiAttrs();
  }

  /** 有槳力加成的零件（純帆不可選） */
  function isPaddlePart(partOrId) {
    const p =
      typeof partOrId === "object" && partOrId
        ? partOrId
        : PARTS[String(partOrId)];
    return !!(p && (p.bonus["槳力"] || 0) > 0);
  }

  /** 純帆時清掉已選槳零件與槳力優先 */
  function stripPaddleForPureSail() {
    if (!isPureSailProfile()) return false;
    let changed = false;
    attrPriority["槳力"] = "";
    for (const round of rounds) {
      for (let i = 0; i < round.parts.length; i++) {
        if (round.parts[i] && isPaddlePart(round.parts[i])) {
          round.parts[i] = "";
          changed = true;
        }
      }
      if (round.values) round.values["槳力"] = round.values["槳力"] || 0;
      if (round.locks) round.locks["槳力"] = false;
    }
    if (filterAttr === "槳力") filterAttr = null;
    return changed;
  }

  /** 仍可強化的屬性（只有達/超上限的不能強，其他照常） */
  function enhanceableAttrs(totals) {
    return ATTRS.filter((a) => canEnhanceAttr(totals[a] || 0, a));
  }

  /** 使用者有填優先的屬性（排序：數字小→大，同序照 ATTRS） */
  function userPriorityAttrs() {
    return ATTRS.filter((a) => isAutoAllocTarget(a)).sort((a, b) => {
      const d = getAutoPriority(a) - getAutoPriority(b);
      return d !== 0 ? d : ATTRS.indexOf(a) - ATTRS.indexOf(b);
    });
  }

  /** 自動配可用零件池（純帆排除槳） */
  function getPartPool() {
    return Object.values(PARTS).filter(
      (p) => !(isPureSailProfile() && isPaddlePart(p))
    );
  }

  /** 窮舉所有 4 件組合，回呼 (ids, cap) */
  function forEachFourCombo(fn) {
    const all = getPartPool();
    const n = all.length;
    if (n < SLOTS) return;
    for (let i = 0; i < n - 3; i++) {
      for (let j = i + 1; j < n - 2; j++) {
        for (let k = j + 1; k < n - 1; k++) {
          for (let l = k + 1; l < n; l++) {
            const ids = [all[i].id, all[j].id, all[k].id, all[l].id];
            fn(ids, roundPartCap({ parts: ids }));
          }
        }
      }
    }
  }

  /** 本輪自動配共用的 maxBurst 與 gains 快取（一次窮舉填多屬性） */
  let maxBurstCache = null;
  let gainsCache = null;

  function clearMaxBurstCache() {
    maxBurstCache = null;
    gainsCache = null;
  }

  function getAttrGains(attr) {
    if (!gainsCache) gainsCache = {};
    if (gainsCache[attr]) return gainsCache[attr];
    const set = new Set();
    forEachFourCombo((ids, cap) => {
      const c = cap[attr] || 0;
      if (c > 0) set.add(c);
    });
    gainsCache[attr] = Array.from(set);
    return gainsCache[attr];
  }

  /**
   * 離散可達天花板 pre：在 parkRounds 輪內，從 start 出發可達的最大累計數值 s (start <= s <= L-1)
   */
  function reachablePre(attr, { start = 0, parkRounds = 0 } = {}) {
    const L = getAttrLimit(attr);
    if (L == null || L <= 0 || start >= L || parkRounds <= 0) {
      return start;
    }
    const gains = getAttrGains(attr);
    if (!gains.length) return start;

    const size = L - start;
    const minRounds = new Int32Array(size).fill(999999);
    minRounds[0] = 0;

    for (let i = 0; i < size; i++) {
      const r = minRounds[i];
      if (r >= parkRounds) continue;
      const curVal = start + i;
      for (let j = 0; j < gains.length; j++) {
        const g = gains[j];
        const nextVal = curVal + g;
        if (nextVal < L) {
          const nextIdx = nextVal - start;
          if (r + 1 < minRounds[nextIdx]) {
            minRounds[nextIdx] = r + 1;
          }
        }
      }
    }

    for (let i = size - 1; i >= 0; i--) {
      if (minRounds[i] <= parkRounds) {
        return start + i;
      }
    }
    return start;
  }

  /**
   * 一次窮舉填入各屬性最大決勝 4 件（供單軸最高／多方案共用）
   */
  function ensureMaxBurstCache(attrs) {
    const need = attrs && attrs.length ? attrs : ATTRS.slice();
    if (!maxBurstCache) maxBurstCache = {};
    const missing = need.filter((a) => !maxBurstCache[a]);
    if (!missing.length) return maxBurstCache;
    for (const a of missing) {
      maxBurstCache[a] = { parts: null, burst: -1 };
    }
    forEachFourCombo((ids, cap) => {
      for (const a of missing) {
        const c = cap[a] || 0;
        if (c > maxBurstCache[a].burst) {
          maxBurstCache[a] = { parts: ids.slice(), burst: c };
        }
      }
    });
    for (const a of missing) {
      maxBurstCache[a].burst = Math.max(0, maxBurstCache[a].burst);
    }
    return maxBurstCache;
  }

  /**
   * 單屬性「決勝一擊」最大零件加成（4 件不重複全搜尋）
   * 達上限後不能再強，超限只靠這一輪 → 此值即單軸最大可能超限加成。
   */
  function computeMaxBurst(attr) {
    ensureMaxBurstCache([attr]);
    return maxBurstCache[attr] || { parts: null, burst: 0 };
  }

  /**
   * 單軸離散可達頂：先以 DP 計算 parkRounds(= budget - 1) 輪內離散可達 pre，再 + maxBurst
   * final = pre + burst，over = final - L
   */
  function theoreticalPeak(attr, opts = {}) {
    const start = typeof opts === "object" && opts && opts.start != null ? opts.start : 0;
    const budget =
      typeof opts === "object" && opts && opts.budget != null
        ? opts.budget
        : Number(maxEnhanceCount) || 30;
    const L = getAttrLimit(attr);
    if (L == null) return null;
    if (L <= 0) {
      return { attr, limit: L, pre: 0, burst: 0, final: 0, over: 0 };
    }
    // 已封頂（如接著配時 start ≥ 上限）：不可再強化，決勝加成歸零
    if (start >= L) {
      return {
        attr,
        limit: L,
        pre: start,
        burst: 0,
        final: start,
        over: Math.max(0, start - L),
        sealed: true,
      };
    }
    const { burst, parts } = computeMaxBurst(attr);
    const pre = reachablePre(attr, { start, parkRounds: Math.max(0, budget - 1) });
    const final = pre + burst;
    const over = Math.max(0, final - L);
    return { attr, limit: L, pre, burst, final, over, parts };
  }

  function formatPeakSummary(targets, startTotals, budget = Number(maxEnhanceCount) || 30) {
    if (!targets.length) return "";
    ensureMaxBurstCache(targets);
    const base = startTotals || Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const lines = targets.map((a) => {
      const cur = base[a] || 0;
      const p = theoreticalPeak(a, { start: cur, budget });
      if (!p) return `${a}（無上限）目前 ${cur}`;
      if (p.limit <= 0) return `${a} 上限0（不可強）`;
      if (cur >= p.limit) {
        return `${a} 目前 ${cur}（已封／≥上限${p.limit}）`;
      }
      // 可衝＝目前零件表(SS 品質)可達；極限＝規則天花板 (上限-1)+決勝，換其他品質零件時可能達成
      const ceiling = p.limit - 1 + p.burst;
      const ceilTxt = ceiling > p.final ? `・極限${ceiling}` : "";
      return `${a} 目前${cur}／上限${p.limit}→可衝<strong>${p.final}</strong>（決勝+${p.burst}${ceilTxt}）`;
    });
    return lines.join("<br/>");
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  }

  function buildRadarSvg(totals) {
    const axes = chartAttrs();
    const n = axes.length;
    const size = 168;
    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.34;
    const primary = cssVar("--primary", "#2b6cb0");
    const danger = cssVar("--danger", "#c92a2a");
    const text = cssVar("--text-soft", "#334");
    const grid = cssVar("--border", "rgba(0,0,0,0.12)");
    const toXY = (i, ratio) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const rr = R * Math.max(0, Math.min(1.15, ratio));
      return [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)];
    };

    const gridLevels = [0.25, 0.5, 0.75, 1];
    let grids = "";
    for (const lv of gridLevels) {
      const pts = axes
        .map((_, i) => toXY(i, lv).join(","))
        .join(" ");
      grids += `<polygon points="${pts}" fill="none" stroke="${grid}" stroke-width="1"/>`;
    }

    let spokes = "";
    let labels = "";
    let dataPts = [];
    axes.forEach((a, i) => {
      const [x1, y1] = toXY(i, 1);
      spokes += `<line x1="${cx}" y1="${cy}" x2="${x1}" y2="${y1}" stroke="${grid}" stroke-width="1"/>`;
      const lim = getAttrLimit(a);
      const val = totals[a] || 0;
      const maxV = Math.max(lim != null && lim > 0 ? lim : 0, val, 1);
      const ratio = val / maxV;
      const [px, py] = toXY(i, ratio);
      dataPts.push(`${px},${py}`);
      const [lx, ly] = toXY(i, 1.22);
      const reached = lim != null && val >= lim && lim > 0;
      labels += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="${
        reached ? danger : text
      }" font-weight="${reached ? "700" : "600"}">${SHORT[a]}</text>`;
    });

    const poly = dataPts.join(" ");
    return `<svg class="radar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      ${grids}${spokes}
      <polygon points="${poly}" fill="${primary}" fill-opacity="0.28" stroke="${primary}" stroke-width="2" stroke-linejoin="round"/>
      ${labels}
    </svg>`;
  }

  function formatPlanStats(totals, roundCount, maxR, budget, startTotals) {
    const bg = budget != null ? budget : maxR;
    const axes = chartAttrs();
    const bits = axes.map((a) => {
      const v = totals[a] || 0;
      const lim = getAttrLimit(a);
      const mark = lim != null && v >= lim && lim > 0 ? "✓" : "";
      return `${SHORT[a]}${v}${mark}`;
    });
    // 優先屬性超限合計 + 是否達可達最高
    let overSum = 0;
    const overBits = [];
    const peakBits = [];
    for (const a of userPriorityAttrs()) {
      const lim = getAttrLimit(a);
      const v = totals[a] || 0;
      if (lim != null && v > lim) {
        const o = v - lim;
        overSum += o;
        overBits.push(`${SHORT[a]}+${o}`);
      }
      const peak = theoreticalPeak(a, {
        budget: bg,
        start: (startTotals && startTotals[a]) || 0,
      });
      if (peak && peak.limit > 0) {
        // 極限＝規則天花板 (上限-1)+決勝；與「目前零件可達」不同時並列顯示
        const ceiling = peak.limit - 1 + peak.burst;
        const ceilTxt = ceiling > peak.final ? `(極限${ceiling})` : "";
        if (v >= peak.final) {
          peakBits.push(`${SHORT[a]}滿${ceilTxt}`);
        } else if (v > 0) {
          peakBits.push(`${SHORT[a]}${v}/${peak.final}${ceilTxt}`);
        }
      }
    }
    const overLine =
      overSum > 0
        ? `<br/><span style="color:var(--danger)">超限合計 <b>${overSum}</b>${
            overBits.length ? `（${overBits.join(" ")}）` : ""
          }</span>`
        : "";
    const peakLine = peakBits.length
      ? `<br/><span style="color:var(--primary)">相對可達最高：${peakBits.join(
          " · "
        )}</span>`
      : "";
    return `<div class="plan-stats">輪次 <b>${roundCount}</b>／${maxR}<br/>${bits.join(
      " · "
    )}${overLine}${peakLine}</div>`;
  }

  /** @type {{strategy:{id:string,name:string,desc:string,mode:string,provable:boolean}, rounds:object[], totals:Record<string,number>, roundCount:number, altNames?:string[]}[]} */
  let pendingAutoPlans = [];
  /** @type {"scratch"|"continue"} */
  let autoAllocMode = "scratch";
  /** 接著配時保留的既有輪次 */
  let autoAllocBaseRounds = [];

  function hasExistingProgress() {
    return rounds.some(
      (r) =>
        r.parts.some((p) => p !== "" && p != null) ||
        ATTRS.some((a) => (r.values?.[a] || 0) !== 0) ||
        !!(r.note && String(r.note).trim())
    );
  }

  function getContinueContext() {
    const maxR = Number(maxEnhanceCount);
    const used = rounds.length;
    const remaining = Number.isFinite(maxR) ? Math.max(0, maxR - used) : 0;
    const startTotals = grandTotal();
    return { maxR, used, remaining, startTotals };
  }

  function openAutoPlanModal(plans, maxR, ctx) {
    pendingAutoPlans = plans;
    const list = $("#autoPlanList");
    if (!list) return;
    const shape = isPureSailProfile() ? "六邊形（純帆）" : "七邊形";
    const targets = userPriorityAttrs();
    const priHint = targets
      .map((a) => `${a}${getAutoPriority(a)}`)
      .join("／");
    const isContinue = ctx && ctx.mode === "continue";
    const peakHtml = formatPeakSummary(
      targets,
      isContinue ? ctx.startTotals : null,
      isContinue ? ctx.remaining : maxR
    );
    const modeLine = isContinue
      ? `模式：<b>接著配</b>（已強化 ${ctx.used} 次，再配最多 ${ctx.remaining} 輪）`
      : `模式：<b>從頭配</b>（共 ${maxR} 輪）`;

    // 展開區（推薦）：exact-lex／exact-tradeoff 恆展開；exact-min 僅在優先屬性 <=2 項時展開
    // （<=2 項時「留幾輪自由配」對玩家有意義；>=3 項則併入摺疊區當參考）。
    // 摺疊區：exact-peak 恆在；優先屬性 >=3 項時 exact-min 也併入摺疊區。
    const priCount = userPriorityAttrs().length;
    const isExpandedMode = (m) =>
      m === "exact-lex" || m === "exact-tradeoff" || (m === "exact-min" && priCount <= 2);
    const stopPlans = plans.filter((p) => isExpandedMode(p.strategy.mode));
    const otherPlans = plans.filter((p) => !isExpandedMode(p.strategy.mode));
    // 列表順序：展開區 → 摺疊區（與 pendingAutoPlans 索引一致需重排）
    const ordered = stopPlans.concat(otherPlans);
    pendingAutoPlans = ordered;

    const cardHtml = (plan, idx) => {
      const s = plan.strategy;
      const isRecommended = isExpandedMode(s.mode);
      const roundLabel = isContinue
        ? `新增 ${plan.roundCount} 輪（接在已有 ${ctx.used} 輪後）`
        : `輪次 <b>${plan.roundCount}</b>／${maxR}`;
      const altHtml =
        plan.altNames && plan.altNames.length
          ? `<p class="plan-alt">同解策略：${escapeAttr(
              plan.altNames.join("、")
            )}</p>`
          : "";
      return `<button type="button" class="auto-plan-card plan-user${
        isRecommended ? " plan-stop" : ""
      }" data-plan-idx="${idx}">
          <h4>${escapeAttr(s.name)}</h4>
          <p class="plan-desc">${escapeAttr(s.desc)}</p>
          ${altHtml}
          ${buildRadarSvg(plan.totals)}
          ${formatPlanStats(
            plan.totals,
            plan.roundCount,
            maxR,
            isContinue ? ctx.remaining : maxR,
            isContinue ? ctx.startTotals : null
          ).replace(
            /輪次 <b>\d+<\/b>／\d+/,
            roundLabel
          )}
          <span class="plan-pick btn-primary" style="display:block;padding:6px 8px;border-radius:8px;font-size:13px">選擇此方案</span>
        </button>`;
    };

    let cardsHtml = "";
    let idx = 0;
    if (stopPlans.length) {
      cardsHtml += `<div class="plan-section-label">推薦方案（可證）</div>`;
      for (const p of stopPlans) {
        cardsHtml += cardHtml(p, idx++);
      }
    }
    if (otherPlans.length) {
      const foldedHasMin = otherPlans.some((p) => p.strategy.mode === "exact-min");
      const foldedTitle = foldedHasMin
        ? `單軸最高與參考（${otherPlans.length}）`
        : `單軸最高（${otherPlans.length}）`;
      // 依使用者回饋：不摺疊，全部平鋪（彈窗已放大）
      cardsHtml += `<div class="plan-section-label">${foldedTitle}</div>`;
      for (const p of otherPlans) {
        cardsHtml += cardHtml(p, idx++);
      }
    }

    list.innerHTML =
      (peakHtml
        ? `<div class="peak-summary"><div class="peak-title">各優先·可衝目標${
            isContinue ? "（從目前數值起算）" : "（單軸可達最高）"
          }</div><div class="peak-body">${peakHtml}</div><div class="peak-hint">最上方為可證最優推薦方案；下方為單軸最高與參考。</div></div>`
        : "") + cardsHtml;

    const intro = document.querySelector(".auto-plan-intro");
    if (intro) {
      intro.innerHTML = `${modeLine}<br/>依你的優先（<b>${
        priHint || "未設定"
      }</b>）產生組合。雷達${shape}。點選方案回填主表。`;
    }

    openModal("autoPlanModal");
  }

  function applyAutoPlan(plan) {
    if (!plan || !plan.rounds?.length) {
      toast("方案無效");
      return;
    }
    const newRounds = plan.rounds.map((r) => ({
      parts: r.parts.slice(),
      values: { ...r.values },
      locks: { ...r.locks },
      note: r.note || "",
    }));

    if (autoAllocMode === "continue" && autoAllocBaseRounds.length) {
      rounds = [
        ...autoAllocBaseRounds.map((r) => ({
          parts: r.parts.slice(),
          values: { ...r.values },
          locks: { ...r.locks },
          note: r.note || "",
        })),
        ...newRounds,
      ];
    } else {
      rounds = newRounds;
    }

    closeModal("autoPlanModal");
    pendingAutoPlans = [];
    autoAllocBaseRounds = [];
    renderAll();
    const msg =
      autoAllocMode === "continue"
        ? `已接上「${plan.strategy.name}」（+${plan.roundCount} 輪，共 ${rounds.length} 輪）`
        : `已套用「${plan.strategy.name}」（${plan.roundCount} 輪）`;
    autoAllocMode = "scratch";
    toast(msg);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 求解器束寬（僅用於「近似」標籤顯示的參考值，須與 js/autoAlloc.js 內部預設同步維護）
  const AUTOALLOC_BEAM_MAIN = 6000;
  const AUTOALLOC_BEAM_PEAK = 1500;

  /** 可證標籤：provable → 〔可證最優〕；boundCertified（優先軸全打到單軸硬上界）→ 優先部分可證；否則束寬近似 */
  function provableTag(provable, beamW, boundCertified) {
    if (provable) return "〔可證最優〕";
    if (boundCertified) return "〔優先屬性可證最優〕";
    return `〔束寬${beamW}近似〕`;
  }

  /** T1（使用者優先數字最小的一層）屬性清單 */
  function t1PriorityAttrs() {
    const targets = userPriorityAttrs();
    if (!targets.length) return [];
    const minP = Math.min(...targets.map((a) => getAutoPriority(a)));
    return targets.filter((a) => getAutoPriority(a) === minP);
  }
  function t1FinalsSum(totals) {
    return t1PriorityAttrs().reduce((s, a) => s + (totals[a] || 0), 0);
  }

  /** exact-* 卡片排序：lex 恆最前；其餘依優先屬性數（<=2 或 >=3）決定，對應 openAutoPlanModal 分組 */
  function exactPlanRank(mode, priCount) {
    if (mode === "exact-lex") return 0;
    if (priCount <= 2) {
      if (mode === "exact-min") return 1;
      if (mode === "exact-tradeoff") return 2;
      return 3; // exact-peak
    }
    if (mode === "exact-tradeoff") return 1;
    if (mode === "exact-peak") return 2;
    return 3; // exact-min
  }

  /**
   * 把 AutoAlloc.solve() 的 rawPlan（{rounds:[[id,id,id,id],...], totals, roundCount}）物件化成
   * 現行 UI plan 管線吃的形狀：依現行規則（canEnhanceAttr + roundPartCap）逐輪重算增量。
   * 防雙實作漂移：物件化後的最終 totals 必須等於 rawPlan.totals，兜不起來就丟棄該卡（回傳 null）。
   */
  function objectifyRawPlan(rawPlan, name, startTotals) {
    const totals = { ...startTotals };
    const objRounds = [];
    for (let i = 0; i < rawPlan.rounds.length; i++) {
      const round = emptyRound();
      round.parts = rawPlan.rounds[i].slice();
      const cap = roundPartCap(round);
      const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));
      for (const a of ATTRS) {
        delta[a] = canEnhanceAttr(totals[a] || 0, a) ? cap[a] || 0 : 0;
        totals[a] = (totals[a] || 0) + delta[a];
      }
      round.values = cumulativeMode ? { ...totals } : { ...delta };
      round.note = `${name} #${i + 1}`;
      objRounds.push(round);
    }
    for (const a of ATTRS) {
      if ((totals[a] || 0) !== (rawPlan.totals[a] || 0)) {
        console.error(
          "autoAlloc 物件化 totals 不符，丟棄該卡：",
          name,
          a,
          "物件化=",
          totals[a],
          "solve=",
          rawPlan.totals[a]
        );
        return null;
      }
    }
    return { rounds: objRounds, totals };
  }

  /** 目前執行中的求解 Worker；null＝沒有在跑或已結束。開新一輪或關閉自動配 modal 時 terminate。 */
  let activeAutoAllocWorker = null;

  function terminateActiveAutoAllocWorker() {
    if (activeAutoAllocWorker) {
      activeAutoAllocWorker.terminate();
      activeAutoAllocWorker = null;
    }
    setAutoAllocBusy(false);
  }

  /** 計算期間鎖住自動配按鈕：防連點疊加（同步路徑）與計算中重複派工 */
  function setAutoAllocBusy(busy) {
    const btn = $("#autoAllocBtn");
    if (btn) btn.disabled = !!busy;
  }

  function buildAndShowAutoPlans(mode) {
    terminateActiveAutoAllocWorker(); // 上一輪若還沒結束（如連點兩次），先收掉避免資源外洩
    const maxR = Number(maxEnhanceCount);
    const isContinue = mode === "continue";
    let budget = maxR;
    let startTotals = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    let ctx = { mode: "scratch", used: 0, remaining: maxR, startTotals: null };

    if (isContinue) {
      const c = getContinueContext();
      if (c.remaining < 1) {
        toast(`已用滿強化次數（${c.used}/${c.maxR}），無法接著配`);
        return;
      }
      autoAllocMode = "continue";
      autoAllocBaseRounds = rounds.map((r) => ({
        parts: r.parts.slice(),
        values: { ...r.values },
        locks: { ...r.locks },
        note: r.note || "",
      }));
      budget = c.remaining;
      startTotals = { ...c.startTotals };
      ctx = {
        mode: "continue",
        used: c.used,
        remaining: c.remaining,
        startTotals: c.startTotals,
      };
    } else {
      autoAllocMode = "scratch";
      autoAllocBaseRounds = [];
      budget = maxR;
      ctx = { mode: "scratch", used: 0, remaining: maxR, startTotals: null };
    }

    // targets 在派工當下就凍結（不管走 Worker 或同步路徑都用同一份，避免計算期間
    // 使用者又改了優先/上限導致「算的」跟「顯示轉換用的」對不起來）。
    const targets = userPriorityAttrs();
    if (!targets.length) {
      toast("請至少設定一組「上限」+「優先」");
      return;
    }

    setAutoAllocBusy(true);
    const input = {
      parts: PARTS,
      attrs: ATTRS,
      limits: Object.fromEntries(ATTRS.map((a) => [a, getAttrLimit(a)])),
      // 與 UI 契約對齊：優先「數字＋上限」都有填才是自動配目標（isAutoAllocTarget），
      // 只填優先沒填上限的屬性不悄悄參與求解（否則會影響結果卻永遠沒有對應卡片）
      priorities: Object.fromEntries(
        ATTRS.map((a) => [a, isAutoAllocTarget(a) ? getAutoPriority(a) : null])
      ),
      budget,
      startTotals,
      pureSail: isPureSailProfile(),
      slots: SLOTS,
    };

    toast(
      isContinue
        ? `正在從已強化 ${ctx.used} 次接著計算（剩餘 ${ctx.remaining} 輪）…`
        : "正在依你的優先從頭計算最優方案…"
    );

    // 優先嘗試 Worker（背景執行緒跑求解，介面不凍結）；建構失敗（不支援）或執行期出錯
    // （如 file:// 直開時 importScripts 拿不到檔案）都無縫退回現行同步路徑，行為一致。
    let worker = null;
    try {
      worker = new Worker("js/autoAlloc.worker.js");
    } catch (err) {
      worker = null;
    }

    if (!worker) {
      runAutoAllocSync(input, targets, ctx, maxR, isContinue);
      return;
    }

    let settled = false;
    const finishOnce = (fn) => {
      if (settled) return;
      settled = true;
      // 只有仍是「目前活躍 worker」才有資格收尾；被新一輪取代的舊 worker 訊息一律丟棄
      const isActive = activeAutoAllocWorker === worker;
      worker.terminate();
      if (!isActive) return;
      activeAutoAllocWorker = null;
      setAutoAllocBusy(false);
      fn();
    };
    activeAutoAllocWorker = worker;
    worker.onerror = (err) => {
      console.error("autoAlloc worker 執行失敗，改用同步路徑", err);
      finishOnce(() => runAutoAllocSync(input, targets, ctx, maxR, isContinue));
    };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "progress") {
        toast(`精確計算中…第 ${msg.depth}/${msg.budget} 層（${msg.mode === "dense" ? "精確" : "束搜"}）`);
        return;
      }
      if (msg.type === "error") {
        console.error("autoAlloc worker 內部錯誤，改用同步路徑", msg.message);
        finishOnce(() => runAutoAllocSync(input, targets, ctx, maxR, isContinue));
        return;
      }
      if (msg.type === "done") {
        finishOnce(() => finishAutoPlans(msg.result, targets, ctx, maxR, isContinue, startTotals));
      }
    };
    worker.postMessage(input);
  }

  /** 無 Worker 支援時的退回路徑：跟改版前完全一樣的 setTimeout 同步計算 */
  function runAutoAllocSync(input, targets, ctx, maxR, isContinue) {
    setTimeout(() => {
      try {
        const result = AutoAlloc.solve(input);
        finishAutoPlans(result, targets, ctx, maxR, isContinue, input.startTotals);
      } catch (err) {
        console.error("AutoAlloc.solve", err);
        toast("求解器發生錯誤，請檢查主控台");
      } finally {
        setAutoAllocBusy(false);
      }
    }, 30);
  }

  /** Worker／同步兩條路徑共用：把 solve() 結果轉成現行 plan 形狀陣列並開 modal */
  function finishAutoPlans(result, targets, ctx, maxR, isContinue, startTotals) {
    clearMaxBurstCache();

    // 優先屬性已全數封頂：lex 也是 0 輪空方案，無需規劃
    if (!result.lex || result.lex.plan.roundCount === 0) {
      toast("優先屬性已全數封頂，無需規劃");
      return;
    }

    const priCount = targets.length;
    const raw = []; // { mode, id, name, desc, provable, rawPlan }

    if (result.minRounds && result.minRounds.plan.roundCount > 0) {
      const p = result.minRounds.plan;
      // 接著配時可自由發揮的是「剩餘輪數-本方案輪數」，不是總輪數
      const left = (isContinue ? ctx.remaining : maxR) - p.roundCount;
      raw.push({
        mode: "exact-min",
        id: "exact-min",
        name: "★ 最快達標（留輪自由配）",
        desc: `${p.roundCount} 輪內優先全數封頂（含超限最大化），剩 ${left} 輪可自行強化其他屬性 ${provableTag(
          result.minRounds.provable,
          AUTOALLOC_BEAM_MAIN
        )}`,
        provable: result.minRounds.provable,
        rawPlan: p,
      });
    }

    raw.push({
      mode: "exact-lex",
      id: "exact-lex",
      name: "★ 全優先衝頂（超限最大）",
      desc: `優先1全到頂 → 2最高 → 超限最大 ${provableTag(
        result.lex.provable,
        AUTOALLOC_BEAM_MAIN,
        result.lex.boundCertified
      )}`,
      provable: result.lex.provable,
      rawPlan: result.lex.plan,
    });

    const lexT1 = t1FinalsSum(result.lex.plan.totals);
    result.tradeoffs.forEach((t, i) => {
      if (!t.plan.roundCount) return;
      if (t1FinalsSum(t.plan.totals) === lexT1) return; // T1 超限與 lex 相同＝雜訊，略過
      raw.push({
        mode: "exact-tradeoff",
        id: `exact-tradeoff-${i}`,
        name: `★ 折衷 ${t.plan.roundCount} 輪`,
        desc: `輪數與超限的中間點：${t.plan.roundCount} 輪 ${provableTag(t.provable, AUTOALLOC_BEAM_MAIN)}`,
        provable: t.provable,
        rawPlan: t.plan,
      });
    });

    for (const a of targets) {
      const peak = result.peaks[a];
      if (!peak || !peak.plan.roundCount) continue;
      raw.push({
        mode: "exact-peak",
        id: `exact-peak-${a}`,
        name: `★ 最高${a}`,
        desc: `單軸 ${a} 衝 ${peak.final} ${provableTag(peak.provable, AUTOALLOC_BEAM_PEAK)}`,
        provable: peak.provable,
        rawPlan: peak.plan,
      });
    }

    // 物件化＋防漂移檢查；totals 對不上的卡直接丟棄
    const plans = [];
    for (const r of raw) {
      const obj = objectifyRawPlan(r.rawPlan, r.name, startTotals);
      if (!obj) continue;
      plans.push({
        strategy: { id: r.id, name: r.name, desc: r.desc, mode: r.mode, provable: r.provable },
        rounds: obj.rounds,
        totals: obj.totals,
        roundCount: r.rawPlan.roundCount,
      });
    }

    if (!plans.length) {
      toast(
        isContinue
          ? "無法接著配置：優先可能都已封頂，或剩餘次數不足"
          : "無法自動配置：請檢查上限、優先與零件資料"
      );
      return;
    }

    plans.sort(
      (p, q) => exactPlanRank(p.strategy.mode, priCount) - exactPlanRank(q.strategy.mode, priCount)
    );

    // 第二次去重：同結果（totals+輪數）不同卡合併，保留排序後首見者
    const dedupedPlans = [];
    const seenSig2 = new Set();
    for (const p of plans) {
      const sig2 = ATTRS.map((a) => p.totals[a] || 0).join(",") + "|r" + p.roundCount;
      if (seenSig2.has(sig2)) {
        const existing = dedupedPlans.find(
          (dp) => ATTRS.map((a) => dp.totals[a] || 0).join(",") + "|r" + dp.roundCount === sig2
        );
        if (existing) {
          if (!existing.altNames) existing.altNames = [];
          existing.altNames.push(p.strategy.name);
        }
      } else {
        seenSig2.add(sig2);
        dedupedPlans.push(p);
      }
    }

    openAutoPlanModal(dedupedPlans, maxR, ctx);
  }

  /** 一鍵優先推薦：清空後套用指定優先（皆為 1＝同等最優先） */
  function applyPriorityPreset(map, label) {
    attrPriority = Object.fromEntries(ATTRS.map((a) => [a, ""]));
    for (const [a, p] of Object.entries(map)) {
      if (ATTRS.includes(a)) attrPriority[a] = p;
    }
    // 純帆時不寫入槳力優先
    if (isPureSailProfile()) attrPriority["槳力"] = "";
    renderAll();
    const used = ATTRS.filter((a) => attrPriority[a] !== "")
      .map((a) => `${a}${attrPriority[a]}`)
      .join("·");
    toast(`${label}：${used || "（無）"}`);
  }

  /** 一鍵自動配：已選船 → 依船型自動帶優先直接產生方案；未選船 → 引導到船選單 */
  function quickAutoConfig() {
    if (!selectedShipKey) {
      toast("請先在右側「套用船隻上限」選擇你的船 →");
      const sel = $("#shipLimitSelector");
      if (sel) {
        sel.scrollIntoView({ behavior: "smooth", block: "center" });
        sel.classList.add("flash-attn");
        setTimeout(() => sel.classList.remove("flash-attn"), 2600);
      }
      return;
    }
    const type = selectedShipKey.split("|")[0];
    if (type === "排船" || type === "砲船") {
      applyPriorityPreset({ 轉向: 1, 護甲: 1, 船耐: 1 }, "戰優先（依船型）");
    } else {
      applyPriorityPreset({ 橫帆: 1, 縱帆: 1, 抗浪: 1 }, "商／冒險優先（依船型）");
    }
    runAutoAllocate();
  }

  /** 快速開始引導條：尚無任何進度且未關閉時顯示 */
  function updateQuickStart() {
    const bar = $("#quickStartBar");
    if (!bar) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem("gvlShip_qsDismiss") === "1";
    } catch {
      /* ignore */
    }
    bar.hidden = dismissed || hasExistingProgress();
  }

  /**
   * 自動配：先選從頭／接著 → 多方案雷達 → 回填主表
   */
  function runAutoAllocate() {
    // 用過一次後停止按鈕脈動提示
    $("#autoAllocBtn")?.classList.add("auto-used");
    try {
      localStorage.setItem("gvlShip_autoUsed", "1");
    } catch {
      /* ignore */
    }
    const maxR = Number(maxEnhanceCount);
    if (!Number.isFinite(maxR) || maxR < 1) {
      toast("請先設定強化次數上限（至少 1）");
      $("#maxEnhanceCountInput")?.focus();
      return;
    }
    if (maxR > 30) {
      toast("強化次數上限請設在 30 以內");
      return;
    }

    const hasAnyTarget = ATTRS.some((a) => isAutoAllocTarget(a));
    if (!hasAnyTarget) {
      toast("請至少設定一組「上限」+「優先」（優先留白表示不列入自動配參考）");
      return;
    }

    const canContinue = hasExistingProgress();
    const cont = getContinueContext();
    const hint = $("#autoModeHint");
    const btnCont = $("#autoModeContinue");
    const btnScratch = $("#autoModeScratch");

    if (hint) {
      if (canContinue) {
        hint.innerHTML = `目前已有 <b>${cont.used}</b> 輪配置（強化次數上限 ${
          cont.maxR
        }，剩餘 <b>${cont.remaining}</b> 次）。<br/>
        <b>從頭配</b>：忽略現有輪次，依優先重新規劃。<br/>
        <b>接著配</b>：保留現有輪次與數值，只規劃剩餘次數（仍依優先）。`;
      } else {
        hint.innerHTML = `尚未有既有強化進度，將從頭依你的優先規劃（共 ${maxR} 輪）。`;
      }
    }

    if (btnScratch) {
      btnScratch.innerHTML = `從頭配<small>重新規劃全部 ${maxR} 輪</small>`;
    }
    if (btnCont) {
      if (!canContinue) {
        btnCont.disabled = true;
        btnCont.innerHTML = `接著現有配置<small>目前沒有可接續的進度</small>`;
      } else if (cont.remaining < 1) {
        btnCont.disabled = true;
        btnCont.innerHTML = `接著現有配置<small>已用滿 ${cont.used}/${cont.maxR} 次</small>`;
      } else {
        btnCont.disabled = false;
        btnCont.innerHTML = `接著現有配置<small>已強化 ${cont.used} 次 → 再配 ${cont.remaining} 輪</small>`;
      }
    }

    // 沒有既有進度時直接從頭，少一步
    if (!canContinue) {
      buildAndShowAutoPlans("scratch");
      return;
    }

    openModal("autoModeModal");
  }

  function syncEnhanceCountInput() {
    const el = $("#maxEnhanceCountInput");
    if (el && el.value !== String(maxEnhanceCount)) {
      el.value = maxEnhanceCount;
    }
  }

  /** 扁平化有 limits 的船隻清單 */
  function shipsWithLimits() {
    const list = [];
    for (const [type, arr] of Object.entries(SHIPS)) {
      for (const s of arr) {
        if (s.limits) {
          list.push({
            type,
            key: `${type}|${s.name}`,
            ...s,
          });
        }
      }
    }
    return list;
  }

  function findShipByKey(key) {
    if (!key) return null;
    const [type, ...rest] = key.split("|");
    const name = rest.join("|");
    const arr = SHIPS[type];
    if (!arr) return null;
    return arr.find((s) => s.name === name) || null;
  }

  function applyShipLimits(key, { silent = false } = {}) {
    selectedShipKey = key || "";
    const ship = findShipByKey(key);
    if (!ship || !ship.limits) {
      if (!silent && key) toast("此船尚無收錄強化上限");
      return false;
    }
    maxLimit = Object.fromEntries(
      ATTRS.map((a) => [
        a,
        ship.limits[a] != null && ship.limits[a] !== ""
          ? String(ship.limits[a])
          : "",
      ])
    );
    // 船隻預設強化次數（如 110 船 6 次）
    if (ship.enhanceCount != null && Number(ship.enhanceCount) > 0) {
      maxEnhanceCount = String(ship.enhanceCount);
    }
    // 純帆：清槳零件／槳優先，介面不出現槳可選
    if (isPureSailProfile()) stripPaddleForPureSail();
    renderAll();
    syncShipLimitSelector();
    if (!silent) {
      const pure = ship.pureSail || ship.limits.槳力 === 0 ? "（純帆·無槳可選）" : "";
      const times =
        ship.enhanceCount != null && Number(ship.enhanceCount) > 0
          ? ` · 強化${ship.enhanceCount}次`
          : "";
      toast(`已套用 Lv.${ship.lv} ${ship.name} 屬性上限${times}${pure}`);
    }
    return true;
  }

  function initShipLimitSelector() {
    const sel = $("#shipLimitSelector");
    if (!sel) return;
    const opts = shipsWithLimits()
      .map((s) => {
        const pure = s.pureSail || s.limits?.槳力 === 0 ? " · 純帆" : "";
        const times =
          s.enhanceCount != null && Number(s.enhanceCount) > 0
            ? ` · ${s.enhanceCount}次`
            : "";
        const icon = D.typeIcons[s.type] || "";
        return `<option value="${escapeAttr(s.key)}">${icon} Lv.${s.lv} ${escapeAttr(s.name)}${times}${pure}</option>`;
      })
      .join("");
    sel.innerHTML = `<option value="">— 手動填寫 —</option>${opts}`;
  }

  function syncShipLimitSelector() {
    const sel = $("#shipLimitSelector");
    if (sel && sel.value !== selectedShipKey) {
      sel.value = selectedShipKey;
    }
  }

  /** 本輪實際增量（拆分值） */
  function roundDelta(roundIndex) {
    const round = rounds[roundIndex];
    if (!cumulativeMode) {
      return { ...round.values };
    }
    // 累計模式：輸入框是到本輪為止的總值
    if (roundIndex === 0) return { ...round.values };
    const prev = rounds[roundIndex - 1].values;
    const out = {};
    for (const a of ATTRS) {
      out[a] = (round.values[a] || 0) - (prev[a] || 0);
    }
    return out;
  }

  /** 各輪結束後的累計總值 */
  function totalsAtRound(roundIndex) {
    if (cumulativeMode) {
      return { ...rounds[roundIndex].values };
    }
    const total = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    for (let i = 0; i <= roundIndex; i++) {
      for (const a of ATTRS) total[a] += rounds[i].values[a] || 0;
    }
    return total;
  }

  function grandTotal() {
    if (!rounds.length) return Object.fromEntries(ATTRS.map((a) => [a, 0]));
    return totalsAtRound(rounds.length - 1);
  }

  function partOptionLabel(p) {
    const marks = ATTRS.filter((a) => (p.bonus[a] || 0) > 0)
      .map((a) => `${SHORT[a]}+${p.bonus[a]}`)
      .join(" ");
    return `${p.name}${marks ? "（" + marks + "）" : ""}`;
  }

  /**
   * 同一輪內已選零件 id（字串），可排除指定欄位（該欄目前選擇仍可顯示）。
   * @param {(string|number)[]} parts
   * @param {number} [excludeSlot]
   */
  function takenPartIds(parts, excludeSlot) {
    const taken = new Set();
    parts.forEach((id, i) => {
      if (id === "" || id == null) return;
      if (excludeSlot !== undefined && i === excludeSlot) return;
      taken.add(String(id));
    });
    return taken;
  }

  /** 同一輪不可重複：保留第一次出現，其餘重複欄清空 */
  function dedupeRoundParts(round) {
    const seen = new Set();
    let changed = false;
    round.parts = round.parts.map((id) => {
      if (id === "" || id == null) return "";
      const key = String(id);
      if (seen.has(key)) {
        changed = true;
        return "";
      }
      seen.add(key);
      return id;
    });
    return changed;
  }

  /** 零件是否通過材料遮罩（遮罩為空=全過；有選屬性=至少一項加成>0） */
  function passesPartMask(p) {
    if (!partMaskAttrs.size) return true;
    for (const a of partMaskAttrs) {
      if ((p.bonus[a] || 0) > 0) return true;
    }
    return false;
  }

  function partOptionsHtml(selected, filter, takenIds) {
    const taken = takenIds || new Set();
    const pure = isPureSailProfile();
    let list = Object.values(PARTS);
    // 純帆：不可選有槳力加成的零件
    if (pure) list = list.filter((p) => !isPaddlePart(p));
    // 材料遮罩：只顯示對選中屬性有加成的零件
    list = list.filter((p) => passesPartMask(p));
    const filtered = filter
      ? list.filter((p) => (p.bonus[filter] || 0) > 0)
      : list;
    const opts = ['<option value="">— 選擇零件 —</option>'];
    const listed = new Set();
    for (const p of filtered) {
      const id = String(p.id);
      // 本輪其他欄已選的零件不出現；目前此欄已選的仍保留
      if (taken.has(id) && id !== String(selected || "")) continue;
      listed.add(id);
      const sel = String(selected) === id ? " selected" : "";
      opts.push(`<option value="${p.id}"${sel}>${partOptionLabel(p)}</option>`);
    }
    // 篩選/遮罩時仍保留目前已選但不符條件的零件（純帆不保留槳零件）
    if (selected && !listed.has(String(selected)) && PARTS[String(selected)]) {
      if (!(pure && isPaddlePart(selected))) {
        const p = PARTS[String(selected)];
        opts.push(
          `<option value="${p.id}" selected>${partOptionLabel(p)}（目前選擇）</option>`
        );
      }
    }
    return opts.join("");
  }

  function renderPartMask() {
    const group = $("#partMaskGroup");
    if (!group) return;
    // 純帆時遮罩不含槳力
    const attrs = uiAttrs();
    // 清掉已不存在於 uiAttrs 的遮罩（如純帆的槳）
    for (const a of [...partMaskAttrs]) {
      if (!attrs.includes(a)) partMaskAttrs.delete(a);
    }
    const chips = attrs
      .map((a) => {
        const on = partMaskAttrs.has(a) ? " active" : "";
        return `<button type="button" class="part-mask-btn filter-btn${on}" data-mask-attr="${a}" title="只顯示有「${a}」加成的零件">${SHORT[a] || a}</button>`;
      })
      .join("");
    const clearBtn = partMaskAttrs.size
      ? `<button type="button" class="part-mask-clear btn-ghost" data-mask-clear="1" title="清除遮罩">清除</button>`
      : "";
    group.innerHTML = `<span class="part-mask-label">材料遮罩</span>${chips}${clearBtn}`;
  }

  function renderRounds() {
    const root = $("#rounds");
    const countHint =
      maxEnhanceCount !== "" && Number(maxEnhanceCount) > 0
        ? ` / ${maxEnhanceCount}`
        : "";
    root.innerHTML = rounds
      .map((round, ri) => {
        const cap = roundPartCap(round);
        const delta = roundDelta(ri);
        const prev = prevTotalsBefore(ri);
        const selects = round.parts
          .map((pid, si) => {
            let cls = "";
            if (sourceTrace.attr && pid) {
              const b = partBonus(pid);
              const inScope =
                sourceTrace.global || sourceTrace.ri === ri;
              if (inScope && b && b[sourceTrace.attr] > 0) cls = " source-hit";
            }
            const taken = takenPartIds(round.parts, si);
            return `<select data-ri="${ri}" data-si="${si}" class="part-select${cls}">${partOptionsHtml(
              pid,
              filterAttr,
              taken
            )}</select>`;
          })
          .join("");

        const partsOk = isPartsComplete(round);
        const attrItems = uiAttrs().map((a) => {
          const sealed = !canEnhanceAttr(prev[a] || 0, a);
          const gain = sealed ? 0 : cap[a] || 0;
          // 未選滿零件時一律顯示全部素質，不因精簡模式隱藏
          const hidden =
            partsOk &&
            !showAllAttrs &&
            gain === 0 &&
            !(round.values[a] > 0) &&
            !sealed;
          if (hidden) return "";
          const displayVal = cumulativeMode
            ? round.values[a] || 0
            : round.values[a] || 0;
          const zero = gain === 0 ? " zero-gain" : "";
          const src =
            sourceTrace.attr === a
              ? " source-hit"
              : "";
          const sealedCls = sealed ? " sealed" : "";
          const capText = sealed ? "已封" : `≤${gain}`;
          const capTitle = sealed
            ? "已達屬性上限，本輪不可再強化"
            : "點擊鎖定/解鎖";
          return `
            <div class="attr-item${zero}${src}${sealedCls}" data-attr="${a}">
              <span class="attr-label" data-attr="${a}" data-ri="${ri}" title="點擊追蹤來源">${SHORT[a]}</span>
              <input class="attr-input${round.locks[a] ? " locked" : ""}"
                type="number" data-ri="${ri}" data-attr="${a}" value="${displayVal}" />
              <em class="attr-cap${round.locks[a] ? " locked" : ""}${sealed ? " sealed-cap" : ""}"
                data-ri="${ri}" data-attr="${a}" title="${capTitle}">${capText}</em>
            </div>`;
        }).join("");

        const filledN = countFilledParts(round);
        const incompleteHint = partsOk
          ? ""
          : `<div class="round-warn">⚠ 每輪須選滿 ${SLOTS} 個不同零件（目前 ${filledN}/${SLOTS}）</div>`;

        return `
          <div class="round-card${partsOk ? "" : " incomplete"}" data-ri="${ri}">
            <div class="round-head">
              <span class="round-number">強化 ${ri + 1}${countHint}</span>
              <div class="part-selects">${selects}</div>
              <input class="note-input" data-ri="${ri}" placeholder="備註" value="${escapeAttr(
                round.note
              )}" />
              <div class="round-actions">
                <button type="button" class="icon-btn" data-act="fill" data-ri="${ri}" title="智能填充">⚡</button>
                <button type="button" class="icon-btn" data-act="clear-vals" data-ri="${ri}" title="清除數值">✕</button>
                <button type="button" class="btn-ghost" data-act="clear-parts" data-ri="${ri}">清除零件</button>
                <button type="button" class="btn-ghost" data-act="insert" data-ri="${ri}">插入</button>
                <button type="button" class="btn-danger" data-act="delete" data-ri="${ri}">刪除</button>
              </div>
            </div>
            ${incompleteHint}
            <div class="attr-row">${attrItems}
              <div class="row-tools">
                <small style="color:var(--muted)" title="可強化時增量應等於零件加總；已封屬性為 0">本輪增量：${uiAttrs().filter((a) => delta[a] || (cap[a] && !canEnhanceAttr(prev[a] || 0, a))).map((a) => {
                  const d = delta[a] || 0;
                  const c = cap[a] || 0;
                  const sealed = !canEnhanceAttr(prev[a] || 0, a);
                  if (sealed && c > 0) return `${SHORT[a]}已封(零件${c})`;
                  if (d !== c && c > 0) return `${SHORT[a]}${d > 0 ? "+" : ""}${d}≠零件${c}`;
                  return `${SHORT[a]}${d > 0 ? "+" : ""}${d}`;
                }).join(" ") || "—"}</small>
              </div>
            </div>
          </div>`;
      })
      .join("");

    if (!rounds.length) {
      root.innerHTML =
        '<div class="empty-hint">尚未有強化輪次，請點「新增輪次」開始配置。</div>';
    }
  }

  function escapeAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function renderSummary() {
    const total = grandTotal();
    const maxBase = Math.max(
      1,
      ...ATTRS.map((a) => {
        const lim = Number(maxLimit[a]);
        return Math.max(total[a] || 0, Number.isFinite(lim) && lim > 0 ? lim : 0);
      })
    );

    $("#summary").innerHTML = uiAttrs()
      .map((a) => {
        const val = total[a] || 0;
        const lim = Number(maxLimit[a]);
        const hasLim = maxLimit[a] !== "" && Number.isFinite(lim) && lim >= 0;
        const pct =
          hasLim && lim > 0
            ? Math.min(100, (val / lim) * 100)
            : Math.min(100, (val / maxBase) * 100);
        const reached = hasLim && val >= lim && lim > 0;
        const pri = attrPriority[a] ?? "";
        return `
        <div class="summary-item">
          <div class="summary-label${filterAttr === a ? " active" : ""}" data-filter="${a}">${a}</div>
          <div class="range-bar${reached ? " reached" : ""}">
            <div class="range-actual" style="width:${pct}%;background:${COLORS[a]}"></div>
          </div>
          <div class="summary-value${reached ? " reached" : ""}">${val}</div>
          <div class="limit-box">
            <span>上限</span>
            <input class="limit-input" type="number" data-limit="${a}" value="${maxLimit[a]}" placeholder="—" min="0" />
          </div>
          <div class="priority-box">
            <span>優先</span>
            <input class="priority-input" type="number" data-priority="${a}" value="${pri}" min="1" max="99" placeholder="—" title="數字愈小愈優先；留白則不列入自動配" />
          </div>
        </div>`;
      })
      .join("");

    syncEnhanceCountInput();
    syncShipLimitSelector();
    renderFilters();
    renderFloat(total);
  }

  function renderFloat(total) {
    const panel = $("#float-summary");
    if (!floatVisible) {
      panel.classList.remove("visible");
      return;
    }
    panel.classList.add("visible");
    $("#float-summary-content").innerHTML = uiAttrs()
      .map((a) => {
        const val = total[a] || 0;
        const lim = Number(maxLimit[a]);
        const hasLim = maxLimit[a] !== "" && lim > 0;
        const pct = hasLim ? Math.min(100, (val / lim) * 100) : 0;
        return `
        <div class="float-item">
          <span class="float-name${filterAttr === a ? " active" : ""}" data-filter="${a}">${SHORT[a]}</span>
          <span style="text-align:right;font-weight:600">${val}</span>
          <div class="float-bar"><span style="width:${pct}%;background:${COLORS[a]}"></span></div>
          <span style="color:var(--muted)">${hasLim ? lim : ""}</span>
        </div>`;
      })
      .join("");
  }

  function renderAll() {
    if (isPureSailProfile()) stripPaddleForPureSail();
    renderPartMask();
    renderRounds();
    renderSummary();
    updateToolbarLabels();
    syncEnhanceCountInput();
    updateQuickStart();
  }

  function updateToolbarLabels() {
    $("#modeToggleBtn").textContent = cumulativeMode ? "累計模式" : "拆分模式";
    $("#autoFillBtn").textContent = autoFill ? "自動填充: ON" : "自動填充: OFF";
    $("#toggleEyeBtn").textContent = showAllAttrs ? "👁️ 全顯" : "👁️ 精簡";
    $("#toggleInputs").textContent = cumulativeMode
      ? "顯示：累計總值"
      : "顯示：本輪增量";
  }

  function bindStatic() {
    $("#addRoundBtn").addEventListener("click", () => {
      const maxR = Number(maxEnhanceCount);
      if (Number.isFinite(maxR) && maxR > 0 && rounds.length >= maxR) {
        toast(`已達強化次數上限（${maxR} 次）`);
        return;
      }
      const r = emptyRound();
      rounds.push(r);
      renderAll();
    });

    // 材料遮罩：點屬性縮寫切換；可多選（符合任一有加成即顯示）
    $("#partMaskGroup")?.addEventListener("click", (e) => {
      const clear = e.target.closest("[data-mask-clear]");
      if (clear) {
        partMaskAttrs.clear();
        renderAll();
        toast("已清除材料遮罩");
        return;
      }
      const btn = e.target.closest("[data-mask-attr]");
      if (!btn) return;
      const a = btn.dataset.maskAttr;
      if (!a) return;
      if (partMaskAttrs.has(a)) partMaskAttrs.delete(a);
      else partMaskAttrs.add(a);
      renderAll();
      if (partMaskAttrs.size) {
        toast(
          `材料遮罩：${[...partMaskAttrs].join("、")}（只顯示有加成的零件）`
        );
      } else {
        toast("材料遮罩：顯示全部零件");
      }
    });

    $("#autoAllocBtn")?.addEventListener("click", runAutoAllocate);
    $("#quickAutoBtn")?.addEventListener("click", quickAutoConfig);
    $("#quickStartDismiss")?.addEventListener("click", () => {
      try {
        localStorage.setItem("gvlShip_qsDismiss", "1");
      } catch {
        /* ignore */
      }
      updateQuickStart();
      toast("已隱藏快速開始（重設瀏覽器資料可復原）");
    });

    $("#autoModeClose")?.addEventListener("click", () => {
      terminateActiveAutoAllocWorker();
      closeModal("autoModeModal");
    });
    $("#autoModeCancel")?.addEventListener("click", () => {
      terminateActiveAutoAllocWorker();
      closeModal("autoModeModal");
    });
    $("#autoModeScratch")?.addEventListener("click", () => {
      closeModal("autoModeModal");
      buildAndShowAutoPlans("scratch");
    });
    $("#autoModeContinue")?.addEventListener("click", () => {
      if ($("#autoModeContinue")?.disabled) return;
      closeModal("autoModeModal");
      buildAndShowAutoPlans("continue");
    });

    $("#autoPlanClose")?.addEventListener("click", () => {
      terminateActiveAutoAllocWorker();
      closeModal("autoPlanModal");
    });
    $("#autoPlanCancel")?.addEventListener("click", () => {
      terminateActiveAutoAllocWorker();
      closeModal("autoPlanModal");
    });
    $("#autoPlanList")?.addEventListener("click", (e) => {
      if (e.target.closest(".peak-summary")) return;
      const card = e.target.closest("[data-plan-idx]");
      if (!card) return;
      const idx = Number(card.dataset.planIdx);
      const plan = pendingAutoPlans[idx];
      if (plan) applyAutoPlan(plan);
    });

    $("#maxEnhanceCountInput")?.addEventListener("input", (e) => {
      maxEnhanceCount = e.target.value;
      renderRounds();
    });

    $("#priPresetTrade")?.addEventListener("click", (e) => {
      e.stopPropagation();
      applyPriorityPreset(
        { 橫帆: 1, 縱帆: 1, 抗浪: 1 },
        "商／冒險優先"
      );
    });
    $("#priPresetCombat")?.addEventListener("click", (e) => {
      e.stopPropagation();
      applyPriorityPreset(
        { 轉向: 1, 護甲: 1, 船耐: 1 },
        "戰優先"
      );
    });

    $("#shipLimitSelector")?.addEventListener("change", (e) => {
      const key = e.target.value;
      if (!key) {
        selectedShipKey = "";
        toast("已改為手動填寫上限");
        return;
      }
      applyShipLimits(key);
    });

    $("#modeToggleBtn").addEventListener("click", () => {
      // 切換模式時轉換數值語意
      if (cumulativeMode) {
        // 累計 → 拆分：各輪改存增量
        const next = rounds.map((_, i) => {
          const d = roundDelta(i);
          return {
            ...rounds[i],
            values: d,
          };
        });
        rounds = next;
        cumulativeMode = false;
      } else {
        // 拆分 → 累計：各輪改存總值
        let acc = Object.fromEntries(ATTRS.map((a) => [a, 0]));
        rounds = rounds.map((r) => {
          for (const a of ATTRS) acc[a] += r.values[a] || 0;
          return { ...r, values: { ...acc } };
        });
        cumulativeMode = true;
      }
      renderAll();
    });

    $("#autoFillBtn").addEventListener("click", () => {
      autoFill = !autoFill;
      updateToolbarLabels();
      toast(autoFill ? "已開啟自動填充" : "已關閉自動填充");
    });

    $("#toggleEyeBtn").addEventListener("click", () => {
      showAllAttrs = !showAllAttrs;
      renderAll();
    });

    $("#toggleInputs").addEventListener("click", () => {
      $("#modeToggleBtn").click();
    });

    $("#exportBtn").addEventListener("click", exportConfig);
    const exportImgBtn = document.getElementById("exportImageBtn");
    if (exportImgBtn) {
      exportImgBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        exportResultImage();
      });
    }
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", importConfig);

    $("#filterGroup")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn || !e.currentTarget.contains(btn)) return;
      if (btn.id === "filterAll") setFilter(null, btn);
      else if (btn.dataset.attr) setFilter(btn.dataset.attr, btn);
    });

    $("#helpGuideBtn").addEventListener("click", () => openModal("helpModal"));
    $("#helpClose").addEventListener("click", () => closeModal("helpModal"));

    $("#changelogBtn")?.addEventListener("click", () =>
      openModal("changelogModal")
    );
    $("#changelogClose")?.addEventListener("click", () =>
      closeModal("changelogModal")
    );
    $("#changelogOk")?.addEventListener("click", () =>
      closeModal("changelogModal")
    );
    $("#helpOk").addEventListener("click", () => {
      localStorage.setItem(HELP_KEY, "1");
      closeModal("helpModal");
    });

    $("#uploadBtn").addEventListener("click", openUploadModal);
    $("#uploadClose").addEventListener("click", () => closeModal("uploadModal"));
    $("#uploadCancel").addEventListener("click", () => closeModal("uploadModal"));
    $("#uploadSubmit").addEventListener("click", submitPreset);
    $("#modalShipType").addEventListener("change", updateModalShipNames);

    $("#typeSelector").addEventListener("change", renderPresetList);

    $("#summary-panel").addEventListener("click", (e) => {
      if (e.target.closest(".limit-input")) return;
      if (e.target.closest(".priority-input")) return;
      if (e.target.closest(".auto-alloc-bar")) return;
      if (e.target.closest(".priority-presets")) return;
      if (e.target.closest("select")) return;
      if (e.target.closest(".summary-label")) return;
      if (e.target.closest("button")) return;
      floatVisible = !floatVisible;
      renderSummary();
    });

    // 事件委派：rounds / summary / float
    $("#rounds").addEventListener("change", onRoundsChange);
    $("#rounds").addEventListener("input", onRoundsInput);
    $("#rounds").addEventListener("click", onRoundsClick);

    $("#summary").addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches(".limit-input")) {
        maxLimit[t.dataset.limit] = t.value;
        // 手動改上限後不再綁定船隻預設
        selectedShipKey = "";
        syncShipLimitSelector();
        // 只重繪「已封」狀態，不自動改寫各輪數值（避免增量與零件脫節）
        renderAll();
      }
      if (t.matches(".priority-input")) {
        const raw = t.value.trim();
        if (raw === "") {
          attrPriority[t.dataset.priority] = "";
        } else {
          const n = Number(raw);
          attrPriority[t.dataset.priority] =
            Number.isFinite(n) && n > 0 ? n : "";
        }
      }
    });
    $("#summary").addEventListener("click", (e) => {
      const lab = e.target.closest(".summary-label");
      if (lab) setFilter(lab.dataset.filter, null);
    });

    $("#float-summary").addEventListener("click", (e) => {
      const n = e.target.closest("[data-filter]");
      if (n) setFilter(n.dataset.filter, null);
    });

    // 拖曳浮窗
    enableDrag($("#float-summary"));

    // 點 modal 背景關閉（自動配相關 modal 順帶收掉計算中的 worker）
    $$(".modal").forEach((m) => {
      m.addEventListener("click", (e) => {
        if (e.target === m) {
          if (m.id === "autoPlanModal" || m.id === "autoModeModal") {
            terminateActiveAutoAllocWorker();
          }
          closeModal(m.id);
        }
      });
    });
  }

  function setFilter(attr, btn) {
    filterAttr = attr || null;
    $$(".filter-btn").forEach((b) => b.classList.remove("active"));
    if (!filterAttr) {
      $("#filterAll").classList.add("active");
    } else {
      const b = $(`.filter-btn[data-attr="${filterAttr}"]`);
      if (b) b.classList.add("active");
    }
    renderAll();
  }

  function onRoundsChange(e) {
    const t = e.target;
    if (t.matches(".part-select")) {
      const ri = +t.dataset.ri;
      const si = +t.dataset.si;
      const next = t.value ? Number(t.value) : "";
      // 同一輪不可選重複零件
      if (next !== "" && takenPartIds(rounds[ri].parts, si).has(String(next))) {
        toast("同一輪強化不可重複選擇相同零件");
        t.value = rounds[ri].parts[si] ? String(rounds[ri].parts[si]) : "";
        return;
      }
      // 純帆不可選槳零件
      if (next !== "" && isPureSailProfile() && isPaddlePart(next)) {
        toast("純帆船不可選擇槳力零件");
        t.value = rounds[ri].parts[si] ? String(rounds[ri].parts[si]) : "";
        return;
      }
      rounds[ri].parts[si] = next;
      // 僅在選滿 4 零件時自動填充；未滿則保留原本素質
      if (autoFill && isPartsComplete(rounds[ri])) autoFillRound(ri);
      renderAll();
    }
  }

  function onRoundsInput(e) {
    const t = e.target;
    if (t.matches(".attr-input")) {
      const ri = +t.dataset.ri;
      const attr = t.dataset.attr;
      rounds[ri].values[attr] = Number(t.value) || 0;
      renderSummary();
    }
    if (t.matches(".note-input")) {
      rounds[+t.dataset.ri].note = t.value;
    }
  }

  function onRoundsClick(e) {
    const t = e.target;
    const actBtn = t.closest("[data-act]");
    if (actBtn) {
      const ri = +actBtn.dataset.ri;
      const act = actBtn.dataset.act;
      if (act === "fill") {
        if (!isPartsComplete(rounds[ri])) {
          toast(`請先選滿 ${SLOTS} 個不同零件再智能填充`);
          return;
        }
        autoFillRound(ri);
        renderAll();
        toast(`已填充強化 ${ri + 1}`);
      } else if (act === "clear-vals") {
        for (const a of ATTRS) {
          if (!rounds[ri].locks[a]) rounds[ri].values[a] = 0;
        }
        renderAll();
      } else if (act === "clear-parts") {
        if (actBtn.dataset.confirm !== "1") {
          actBtn.dataset.confirm = "1";
          actBtn.textContent = "再按確認";
          setTimeout(() => {
            actBtn.dataset.confirm = "0";
            actBtn.textContent = "清除零件";
          }, 2000);
          return;
        }
        rounds[ri].parts = Array(SLOTS).fill("");
        if (autoFill) autoFillRound(ri);
        renderAll();
      } else if (act === "insert") {
        const maxR = Number(maxEnhanceCount);
        if (Number.isFinite(maxR) && maxR > 0 && rounds.length >= maxR) {
          toast(`已達強化次數上限（${maxR} 次）`);
          return;
        }
        rounds.splice(ri + 1, 0, emptyRound());
        renderAll();
      } else if (act === "delete") {
        if (rounds.length <= 1) {
          toast("至少保留一輪");
          return;
        }
        rounds.splice(ri, 1);
        renderAll();
      }
      return;
    }

    const cap = t.closest(".attr-cap");
    if (cap) {
      const ri = +cap.dataset.ri;
      const attr = cap.dataset.attr;
      rounds[ri].locks[attr] = !rounds[ri].locks[attr];
      renderAll();
      return;
    }

    const lab = t.closest(".attr-label");
    if (lab) {
      const attr = lab.dataset.attr;
      const ri = +lab.dataset.ri;
      // 同屬性連點：本輪 → 全域 → 關閉
      if (sourceTrace.attr === attr && sourceTrace.ri === ri) {
        if (!sourceTrace.global) sourceTrace = { attr, global: true, ri };
        else sourceTrace = { attr: null, global: false, ri: null };
      } else {
        sourceTrace = { attr, global: false, ri };
      }
      renderAll();
      if (sourceTrace.attr) {
        toast(
          sourceTrace.global
            ? `全域追蹤：${attr}`
            : `第 ${ri + 1} 輪追蹤：${attr}（再點一次改全域）`
        );
      } else {
        toast("已關閉來源追蹤");
      }
    }
  }

  function openModal(id) {
    $("#" + id).classList.add("open");
  }
  function closeModal(id) {
    $("#" + id).classList.remove("open");
  }

  function exportConfig() {
    const payload = {
      version: 2,
      locale: "zh-TW",
      cumulativeMode,
      maxLimit,
      attrPriority: { ...attrPriority },
      maxEnhanceCount,
      selectedShipKey,
      rounds,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `船隻強化方案_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已匯出設定");
  }

  function partDisplayName(partId) {
    if (partId === "" || partId == null) return "（未選）";
    const p = PARTS[String(partId)];
    return p ? p.name : `零件#${partId}`;
  }

  function shipLabelForExport() {
    if (!selectedShipKey) return "未指定船隻";
    try {
      const ship = findShipByKey(selectedShipKey);
      if (!ship) return String(selectedShipKey);
      const pure = ship.pureSail || ship.limits?.槳力 === 0 ? " 純帆" : "";
      return `Lv.${ship.lv} ${ship.name}${pure}`;
    } catch {
      return "船隻";
    }
  }

  function fitText(ctx, str, maxW) {
    let draw = String(str ?? "");
    if (!draw) return "";
    if (maxW <= 0) return draw;
    if (ctx.measureText(draw).width <= maxW) return draw;
    while (draw.length > 1 && ctx.measureText(draw + "…").width > maxW) {
      draw = draw.slice(0, -1);
    }
    return draw + "…";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
  }

  /**
   * 將目前配置繪製成 PNG（含各輪強化材料、數值與最終彙總）
   */
  function exportResultImage() {
    try {
      if (!Array.isArray(rounds) || !rounds.length) {
        toast("尚無強化輪次可匯出");
        return;
      }

      toast("正在產生圖片…");

      const pad = 28;
      const width = 920;
      const lineH = 22;
      const sectionGap = 16;
      const attrs = uiAttrs();
      const total = grandTotal();
      const contentW = width - pad * 2 - 36;

      // —— 先組好各區塊文字，再算高度 ——
      const shipLine = shipLabelForExport();
      const metaLine = `${shipLine}  |  ${rounds.length}輪  |  ${
        cumulativeMode ? "累計" : "拆分"
      }  |  ${new Date().toLocaleString()}`;

      const summaryLines = attrs.map((a) => {
        const val = total[a] || 0;
        const lim = getAttrLimit(a);
        const limTxt = lim != null ? ` / 上限${lim}` : "";
        const over = lim != null && val > lim ? " 超限" : "";
        return { a, text: `${a}  ${val}${limTxt}${over}`, over: !!over };
      });

      const roundBlocks = rounds.map((r, ri) => {
        const parts = Array.isArray(r.parts) ? r.parts : [];
        const materials = parts.map(
          (pid, i) => `${i + 1}.${partDisplayName(pid)}`
        );
        // 每列最多 2 個材料名
        const matLines = [];
        for (let i = 0; i < Math.max(materials.length, 1); i += 2) {
          const chunk = materials.slice(i, i + 2);
          matLines.push(chunk.length ? chunk.join("   ") : "（無材料）");
        }
        const delta = roundDelta(ri);
        const endVals = totalsAtRound(ri);
        const valParts = attrs
          .map((a) => {
            const d = Number(delta[a]) || 0;
            const t = Number(endVals[a]) || 0;
            if (!d && !t) return null;
            return `${SHORT[a]}${d > 0 ? "+" : ""}${d}→${t}`;
          })
          .filter(Boolean);
        const valLine = valParts.length ? valParts.join("  ") : "（無數值）";
        const noteLine = r.note ? `備註：${r.note}` : "";
        const blockH =
          20 +
          lineH +
          matLines.length * lineH +
          lineH +
          (noteLine ? lineH : 0) +
          14;
        return { ri, matLines, valLine, noteLine, blockH };
      });

      const sumH = 28 + Math.ceil(summaryLines.length / 2) * lineH + 14;
      let height = pad + 72 + sectionGap + sumH + sectionGap;
      for (const b of roundBlocks) height += b.blockH + 10;
      height += pad + 24;

      const canvas = document.createElement("canvas");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        toast("瀏覽器不支援 Canvas 繪圖");
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const bg = "#f4faf6";
      const panel = "#ffffff";
      const text = "#1f2d3d";
      const muted = "#6b7c8a";
      const primary = "#2b6cb0";
      const border = "#d5e0e6";
      const danger = "#c92a2a";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      let y = pad;

      // 標題
      roundRect(ctx, pad, y, width - pad * 2, 72, 12);
      ctx.fillStyle = panel;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.font = "bold 22px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
      ctx.fillText("大航海傳說 · 船隻強化方案", pad + 18, y + 32);
      ctx.font = "14px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
      ctx.fillStyle = muted;
      ctx.fillText(fitText(ctx, metaLine, contentW), pad + 18, y + 56);
      y += 72 + sectionGap;

      // 最終屬性
      roundRect(ctx, pad, y, width - pad * 2, sumH, 12);
      ctx.fillStyle = panel;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.stroke();
      ctx.fillStyle = primary;
      ctx.font = "bold 15px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
      ctx.fillText("最終屬性彙總", pad + 18, y + 24);
      ctx.font = "14px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
      const colW = contentW / 2;
      summaryLines.forEach((row, i) => {
        const col = i % 2;
        const rowI = Math.floor(i / 2);
        const x = pad + 18 + col * colW;
        const yy = y + 48 + rowI * lineH;
        ctx.fillStyle = COLORS[row.a] || text;
        ctx.fillRect(x, yy - 10, 8, 8);
        ctx.fillStyle = row.over ? danger : text;
        ctx.fillText(fitText(ctx, row.text, colW - 20), x + 14, yy);
      });
      y += sumH + sectionGap;

      // 各輪（含強化材料）
      ctx.font = "13px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
      for (const block of roundBlocks) {
        roundRect(ctx, pad, y, width - pad * 2, block.blockH, 12);
        ctx.fillStyle = panel;
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.stroke();

        let yy = y + 22;
        ctx.fillStyle = primary;
        ctx.font =
          "bold 15px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
        ctx.fillText(`強化 ${block.ri + 1}`, pad + 18, yy);

        ctx.font = "13px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
        yy += lineH;
        ctx.fillStyle = muted;
        ctx.fillText("強化材料", pad + 18, yy);
        ctx.fillStyle = text;
        for (const line of block.matLines) {
          yy += lineH;
          ctx.fillText(fitText(ctx, line, contentW), pad + 18, yy);
        }

        yy += lineH;
        ctx.fillStyle = muted;
        ctx.fillText("本輪／累計", pad + 18, yy);
        const labelW = ctx.measureText("本輪／累計 ").width;
        ctx.fillStyle = text;
        ctx.fillText(
          fitText(ctx, block.valLine, contentW - labelW),
          pad + 18 + labelW,
          yy
        );

        if (block.noteLine) {
          yy += lineH;
          ctx.fillStyle = muted;
          ctx.fillText(fitText(ctx, block.noteLine, contentW), pad + 18, yy);
        }

        y += block.blockH + 10;
      }

      ctx.fillStyle = muted;
      ctx.font = "12px \"Microsoft JhengHei\",\"Noto Sans TC\",sans-serif";
      ctx.fillText(
        "GvlShipEnhance · 結果圖含強化材料與屬性 · 僅供方案參考",
        pad,
        height - 14
      );

      const safeName = shipLine
        .replace(/[\\/:*?"<>|·\s]+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 40);
      const filename = `ship_enhance_${safeName || "plan"}_${Date.now()}.png`;

      const finish = (blob) => {
        if (!blob) {
          toast("產生圖片失敗");
          return;
        }
        downloadBlob(blob, filename);
        toast("已匯出結果圖片（含各輪材料）");
      };

      if (canvas.toBlob) {
        canvas.toBlob(finish, "image/png");
      } else {
        // 舊瀏覽器 fallback
        const dataUrl = canvas.toDataURL("image/png");
        const bin = atob(dataUrl.split(",")[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        finish(new Blob([arr], { type: "image/png" }));
      }
    } catch (err) {
      console.error("exportResultImage", err);
      toast("匯出圖片失敗：" + (err && err.message ? err.message : "未知錯誤"));
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r || 0, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function importConfig(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.rounds)) throw new Error("格式不正確");
        let deduped = false;
        rounds = data.rounds.map((r) => {
          const round = {
            parts: Array(SLOTS)
              .fill("")
              .map((_, i) => r.parts?.[i] ?? ""),
            values: Object.fromEntries(
              ATTRS.map((a) => [a, Number(r.values?.[a]) || 0])
            ),
            locks: Object.fromEntries(
              ATTRS.map((a) => [a, !!r.locks?.[a]])
            ),
            note: r.note || "",
          };
          if (dedupeRoundParts(round)) deduped = true;
          return round;
        });
        if (typeof data.cumulativeMode === "boolean") {
          cumulativeMode = data.cumulativeMode;
        }
        if (data.maxLimit) maxLimit = { ...maxLimit, ...data.maxLimit };
        if (data.attrPriority) {
          attrPriority = { ...attrPriority, ...data.attrPriority };
        }
        if (data.maxEnhanceCount != null && data.maxEnhanceCount !== undefined) {
          maxEnhanceCount = data.maxEnhanceCount;
        }
        if (data.selectedShipKey) {
          selectedShipKey = data.selectedShipKey;
        }
        renderAll();
        toast(
          deduped
            ? "匯入成功（已移除同輪重複零件）"
            : "匯入成功"
        );
      } catch (err) {
        alert("匯入失敗：" + err.message);
      }
    };
    reader.readAsText(file);
  }

  function loadPresets() {
    try {
      return JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function savePresets(list) {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  }

  function openUploadModal() {
    const sel = $("#modalShipType");
    sel.innerHTML =
      '<option value="">— 類型 —</option>' +
      Object.keys(SHIPS)
        .map((t) => `<option value="${t}">${D.typeIcons[t] || ""} ${t}</option>`)
        .join("");
    $("#modalShipName").innerHTML =
      '<option value="">— 請先選擇類型 —</option>';
    $("#modalDesc").value = "";
    $("#modalAuthor").value = localStorage.getItem("gvlShip_author") || "";
    openModal("uploadModal");
  }

  function updateModalShipNames() {
    const type = $("#modalShipType").value;
    const nameSel = $("#modalShipName");
    if (!type || !SHIPS[type]) {
      nameSel.innerHTML = '<option value="">— 請先選擇類型 —</option>';
      return;
    }
    nameSel.innerHTML =
      '<option value="">— 選擇船隻 —</option>' +
      SHIPS[type]
        .map(
          (s) =>
            `<option value="${s.name}">Lv.${s.lv} ${s.name}</option>`
        )
        .join("");
  }

  function submitPreset() {
    const type = $("#modalShipType").value;
    const ship = $("#modalShipName").value;
    const author = ($("#modalAuthor").value || "").trim() || "匿名船長";
    let desc = ($("#modalDesc").value || "").trim();
    if (!type || !ship) {
      alert("請確認船隻類型與名稱！");
      return;
    }
    if (!desc) {
      const total = grandTotal();
      desc = ATTRS.map((a) => `${a} ${total[a]}`).join(" / ");
    }
    localStorage.setItem("gvlShip_author", author);
    const list = loadPresets();
    list.unshift({
      id: "p_" + Date.now(),
      type,
      ship,
      author,
      desc,
      cumulativeMode,
      maxLimit: { ...maxLimit },
      attrPriority: { ...attrPriority },
      maxEnhanceCount,
      selectedShipKey,
      rounds: JSON.parse(JSON.stringify(rounds)),
      createdAt: new Date().toISOString(),
    });
    savePresets(list);
    closeModal("uploadModal");
    $("#typeSelector").value = type;
    renderPresetList();
    toast("方案已儲存到本機");
  }

  function renderPresetList() {
    const type = $("#typeSelector").value;
    const box = $("#presetDisplayBox");
    if (!type) {
      box.innerHTML =
        '<p class="empty-hint">請選擇船隻類別以查看本機預設方案</p>';
      return;
    }
    const list = loadPresets().filter((p) => p.type === type);
    if (!list.length) {
      box.innerHTML =
        '<p class="empty-hint">此類別尚無方案，上傳目前配置即可建立</p>';
      return;
    }
    box.innerHTML = `<div class="preset-list">${list
      .map(
        (p) => `
      <div class="preset-item" data-id="${p.id}">
        <div class="preset-top">
          <div>
            <div class="preset-title">${escapeAttr(p.ship)}</div>
            <div class="preset-meta">作者：${escapeAttr(p.author)} · ${new Date(
          p.createdAt
        ).toLocaleString()}</div>
            <div class="preset-desc">${escapeAttr(p.desc)}</div>
          </div>
          <div class="preset-actions">
            <button type="button" class="btn-blue" data-load="${p.id}">載入</button>
            <button type="button" class="btn-danger" data-del="${p.id}">刪除</button>
          </div>
        </div>
      </div>`
      )
      .join("")}</div>`;

    box.querySelectorAll("[data-load]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const p = loadPresets().find((x) => x.id === btn.dataset.load);
        if (!p) return;
        rounds = JSON.parse(JSON.stringify(p.rounds));
        let deduped = false;
        for (const r of rounds) {
          if (dedupeRoundParts(r)) deduped = true;
        }
        if (typeof p.cumulativeMode === "boolean") cumulativeMode = p.cumulativeMode;
        if (p.maxLimit) maxLimit = { ...maxLimit, ...p.maxLimit };
        if (p.attrPriority) attrPriority = { ...attrPriority, ...p.attrPriority };
        if (p.maxEnhanceCount != null && p.maxEnhanceCount !== undefined) {
          maxEnhanceCount = p.maxEnhanceCount;
        }
        if (p.selectedShipKey) selectedShipKey = p.selectedShipKey;
        renderAll();
        toast(
          deduped
            ? `已載入：${p.ship}（已移除同輪重複零件）`
            : `已載入：${p.ship}`
        );
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("確定刪除此方案？")) return;
        savePresets(loadPresets().filter((x) => x.id !== btn.dataset.del));
        renderPresetList();
        toast("已刪除");
      });
    });
  }

  function enableDrag(el) {
    let ox = 0,
      oy = 0,
      dragging = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-filter]")) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - ox + "px";
      el.style.top = e.clientY - oy + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    });
    el.addEventListener("pointerup", () => {
      dragging = false;
    });
  }

  function initTypeSelector() {
    const sel = $("#typeSelector");
    sel.innerHTML =
      '<option value="">選擇船隻類型</option>' +
      Object.keys(SHIPS)
        .map(
          (t) =>
            `<option value="${t}">${D.typeIcons[t] || ""} ${t}</option>`
        )
        .join("");
  }

  function renderFilters() {
    const group = $("#filterGroup");
    if (!group) return;
    const attrs = uiAttrs();
    const allActive = !filterAttr ? " active" : "";
    group.innerHTML =
      `<button type="button" class="filter-btn${allActive}" id="filterAll">全選</button>` +
      attrs
        .map((a) => {
          const act = filterAttr === a ? " active" : "";
          return `<button type="button" class="filter-btn${act}" data-attr="${a}">${a}</button>`;
        })
        .join("");
  }

  function resolveColorScheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  }

  function applyTheme(mode) {
    const m =
      mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
    const resolved = resolveColorScheme(m);
    const root = document.documentElement;
    root.setAttribute("data-theme", m);
    root.setAttribute("data-color-scheme", resolved);
    // 同步 class，方便除錯與提高覆蓋力
    root.classList.toggle("theme-dark", resolved === "dark");
    root.classList.toggle("theme-light", resolved === "light");
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      /* ignore */
    }
    const sel = $("#themeSelect");
    if (sel && sel.value !== m) sel.value = m;
  }

  function initTheme() {
    let saved = "system";
    try {
      saved = localStorage.getItem(THEME_KEY) || "system";
    } catch {
      saved = "system";
    }
    applyTheme(saved);

    const sel = $("#themeSelect");
    if (sel) {
      sel.value = saved;
      sel.addEventListener("change", () => {
        applyTheme(sel.value);
        const label =
          sel.value === "system"
            ? `跟隨系統（目前${resolveColorScheme("system") === "dark" ? "深色" : "淺色"}）`
            : sel.value === "dark"
              ? "深色"
              : "淺色";
        toast(`外觀：${label}`);
      });
    }

    // 系統主題變更時，若設為跟隨系統則即時更新
    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        const pref =
          document.documentElement.getAttribute("data-theme") || "system";
        if (pref === "system") applyTheme("system");
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch {
      /* ignore */
    }
  }

  function init() {
    initTheme();
    initTypeSelector();
    initShipLimitSelector();
    rounds = [emptyRound()];
    bindStatic();
    // 用過自動配的老手不再脈動提示
    try {
      if (localStorage.getItem("gvlShip_autoUsed") === "1") {
        $("#autoAllocBtn")?.classList.add("auto-used");
      }
    } catch {
      /* ignore */
    }
    renderFilters();
    renderAll();
    renderPresetList();

    if (!localStorage.getItem(HELP_KEY)) {
      openModal("helpModal");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

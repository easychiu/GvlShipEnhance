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

  /** @type {{ parts: (string|number)[], values: Record<string, number>, locks: Record<string, boolean>, note: string }[]} */
  let rounds = [];
  let filterAttr = null;
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

  /**
   * 評估零件對優先目標的貢獻。
   * 堆疊期（&lt; 上限-1）：偏向能貼近上限前一檔的零件；
   * 決勝期（已在上限-1）：偏向最大加成以便一口氣超限。
   */
  function scorePartForTotals(part, totals) {
    let score = 0;
    for (const a of ATTRS) {
      if (!isAutoAllocTarget(a)) continue;
      const lim = getAttrLimit(a);
      const bonus = part.bonus[a] || 0;
      if (bonus <= 0) continue;
      const p = totals[a] || 0;
      if (!canEnhanceAttr(p, a)) continue;
      const w = priorityWeight(a);
      if (w <= 0) continue;
      const underMax = lim - 1;
      if (p < underMax) {
        const need = underMax - p;
        score += Math.min(bonus, need) * w * 120;
        score += bonus * w * 8;
      } else {
        // 已貼上限前一檔 → 決勝一口氣，越大越好（如 +52）
        score += bonus * w * 260;
      }
    }
    return score;
  }

  /**
   * 本輪是否處於「堆疊控管」：還有後續輪次，且加滿候選零件會超過上限-1。
   * 此時改以「少選零件 + 數值加滿」貼近上限前一檔，避免增量與零件不符。
   */
  function needsParkControl(prevTotal, attr, fullCap, roundsLeft) {
    if (!isAutoAllocTarget(attr)) return false;
    if (!canEnhanceAttr(prevTotal, attr)) return false;
    if (roundsLeft <= 1) return false;
    const L = getAttrLimit(attr);
    const P = prevTotal || 0;
    const C = fullCap || 0;
    const roomUnder = L - 1 - P;
    return roomUnder > 0 && P + C > L - 1;
  }

  /**
   * 從候選零件中挑子集：數值一律依零件加滿，但堆疊期不可超過上限-1。
   * 決勝期（已貼上限-1 或最後一輪）改最大化加成以便超限。
   */
  function refinePartsSubset(partIds, totals, roundsLeft) {
    const ids = partIds.filter((id) => id !== "" && id != null);
    if (!ids.length) return ids;

    const n = ids.length;
    let bestSub = null;
    let bestScore = -Infinity;

    for (let mask = 1; mask < 1 << n; mask++) {
      const sub = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) sub.push(ids[i]);
      }
      const cap = roundPartCap({ parts: sub });
      let valid = true;
      let score = 0;

      for (const a of ATTRS) {
        if (!isAutoAllocTarget(a)) continue;
        const P = totals[a] || 0;
        if (!canEnhanceAttr(P, a)) continue;
        const L = getAttrLimit(a);
        const C = cap[a] || 0;
        const w = priorityWeight(a);
        const roomUnder = L - 1 - P;
        const park = roundsLeft > 1 && roomUnder > 0;

        if (park) {
          // 堆疊：加滿後必須 ≤ 上限-1，並盡量貼近
          if (P + C > L - 1) {
            valid = false;
            break;
          }
          score += C * w * 100;
          // 愈接近上限-1 愈好
          score += (1 - (L - 1 - P - C) / Math.max(L, 1)) * w * 30;
        } else {
          // 決勝：最大化本輪零件加成（可超限）
          score += C * w * 250;
        }
      }
      if (!valid) continue;
      score += sub.length * 0.01;
      if (score > bestScore) {
        bestScore = score;
        bestSub = sub;
      }
    }

    // 找不到合法堆疊子集時退回原清單（最後一輪會直接超限）
    return bestSub && bestScore > -Infinity ? bestSub : ids;
  }

  function greedyPickParts(totals) {
    const partList = Object.values(PARTS);
    const chosen = [];
    const used = new Set();
    for (let slot = 0; slot < SLOTS; slot++) {
      let best = null;
      let bestScore = 0;
      for (const p of partList) {
        if (used.has(p.id)) continue;
        const s = scorePartForTotals(p, totals);
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best || bestScore <= 0) break;
      chosen.push(best.id);
      used.add(best.id);
    }
    return chosen;
  }

  /**
   * 依次數上限、屬性上限、優先順序自動配置各輪零件與數值。
   * - 只為「有優先」的屬性選零件／決定是否繼續開輪
   * - 本輪增量一律 = 零件加總（可強化時加滿；已封則 0），不再暗改數值
   * - 堆疊期用「少選零件」貼上限-1，決勝期一次選滿可超限
   */
  function runAutoAllocate() {
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
      toast("請至少設定一組「上限」+「優先」（優先留白表示不列入自動配）");
      return;
    }

    const hasData = rounds.some(
      (r) => r.parts.some((p) => p !== "" && p != null) || r.note
    );
    if (hasData && !confirm("自動配會重算並取代目前所有輪次，是否繼續？")) {
      return;
    }

    let totals = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const newRounds = [];

    for (let r = 0; r < maxR; r++) {
      const roundsLeft = maxR - r;
      const activeTargets = ATTRS.filter(
        (a) => isAutoAllocTarget(a) && canEnhanceAttr(totals[a] || 0, a)
      );
      if (!activeTargets.length) break;

      let chosen = greedyPickParts(totals);
      if (!chosen.length) break;

      const fullCap = roundPartCap({ parts: chosen });
      const anyPark = activeTargets.some((a) =>
        needsParkControl(totals[a] || 0, a, fullCap[a] || 0, roundsLeft)
      );
      if (anyPark) {
        chosen = refinePartsSubset(chosen, totals, roundsLeft);
      }

      const round = emptyRound();
      round.parts = Array(SLOTS)
        .fill("")
        .map((_, i) => chosen[i] ?? "");
      const cap = roundPartCap(round);

      // 增量與零件一致：可強化則加滿零件上限；已封為 0
      const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));
      for (const a of ATTRS) {
        if (!canEnhanceAttr(totals[a] || 0, a)) {
          delta[a] = 0;
        } else {
          delta[a] = cap[a] || 0;
        }
        totals[a] = (totals[a] || 0) + delta[a];
      }

      const useful = activeTargets.some((a) => (delta[a] || 0) > 0);
      if (!useful) break;

      if (cumulativeMode) {
        round.values = { ...totals };
      } else {
        round.values = { ...delta };
      }

      const burst = activeTargets.some((a) => {
        const lim = getAttrLimit(a);
        const prev = (totals[a] || 0) - (delta[a] || 0);
        return (
          lim != null &&
          (delta[a] || 0) > 0 &&
          prev < lim &&
          (totals[a] || 0) >= lim
        );
      });
      round.note = burst
        ? `自動配 #${r + 1} · 超限決勝`
        : `自動配 #${r + 1} · 堆疊`;
      newRounds.push(round);
    }

    if (!newRounds.length) {
      toast("無法自動配置：請檢查上限、優先與零件資料");
      return;
    }

    rounds = newRounds;
    renderAll();
    toast(`自動配完成：共 ${rounds.length} 輪（增量＝零件加成）`);
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    // 僅帶入上限，不改寫既有輪次數值
    renderAll();
    syncShipLimitSelector();
    if (!silent) {
      const pure = ship.pureSail || ship.limits.槳力 === 0 ? "（純帆·無槳）" : "";
      toast(`已套用 Lv.${ship.lv} ${ship.name} 強化上限${pure}`);
    }
    return true;
  }

  function initShipLimitSelector() {
    const sel = $("#shipLimitSelector");
    if (!sel) return;
    const opts = shipsWithLimits()
      .map((s) => {
        const pure = s.pureSail || s.limits?.槳力 === 0 ? " · 純帆" : "";
        const icon = D.typeIcons[s.type] || "";
        return `<option value="${escapeAttr(s.key)}">${icon} Lv.${s.lv} ${escapeAttr(s.name)}${pure}</option>`;
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

  function partOptionsHtml(selected, filter, takenIds) {
    const taken = takenIds || new Set();
    const list = Object.values(PARTS);
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
    // 篩選時仍保留目前已選但不符條件的零件
    if (selected && !listed.has(String(selected)) && PARTS[String(selected)]) {
      const p = PARTS[String(selected)];
      opts.push(
        `<option value="${p.id}" selected>${partOptionLabel(p)}（目前選擇）</option>`
      );
    }
    return opts.join("");
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

        const attrItems = ATTRS.map((a) => {
          const sealed = !canEnhanceAttr(prev[a] || 0, a);
          const gain = sealed ? 0 : cap[a] || 0;
          const hidden =
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

        return `
          <div class="round-card" data-ri="${ri}">
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
            <div class="attr-row">${attrItems}
              <div class="row-tools">
                <small style="color:var(--muted)" title="可強化時增量應等於零件加總；已封屬性為 0">本輪增量：${ATTRS.filter((a) => delta[a] || (cap[a] && !canEnhanceAttr(prev[a] || 0, a))).map((a) => {
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

    $("#summary").innerHTML = ATTRS.map((a) => {
      const val = total[a] || 0;
      const lim = Number(maxLimit[a]);
      const hasLim = maxLimit[a] !== "" && Number.isFinite(lim) && lim >= 0;
      const pct = hasLim && lim > 0 ? Math.min(100, (val / lim) * 100) : Math.min(100, (val / maxBase) * 100);
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
    }).join("");

    syncEnhanceCountInput();
    syncShipLimitSelector();
    renderFloat(total);
  }

  function renderFloat(total) {
    const panel = $("#float-summary");
    if (!floatVisible) {
      panel.classList.remove("visible");
      return;
    }
    panel.classList.add("visible");
    $("#float-summary-content").innerHTML = ATTRS.map((a) => {
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
    }).join("");
  }

  function renderAll() {
    renderRounds();
    renderSummary();
    updateToolbarLabels();
    syncEnhanceCountInput();
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

    $("#autoAllocBtn")?.addEventListener("click", runAutoAllocate);

    $("#maxEnhanceCountInput")?.addEventListener("input", (e) => {
      maxEnhanceCount = e.target.value;
      renderRounds();
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
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", importConfig);

    $("#filterAll").addEventListener("click", (e) => {
      setFilter(null, e.currentTarget);
    });

    $$(".filter-btn[data-attr]").forEach((btn) => {
      btn.addEventListener("click", () => setFilter(btn.dataset.attr, btn));
    });

    $("#helpGuideBtn").addEventListener("click", () => openModal("helpModal"));
    $("#helpClose").addEventListener("click", () => closeModal("helpModal"));
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

    // 點 modal 背景關閉
    $$(".modal").forEach((m) => {
      m.addEventListener("click", (e) => {
        if (e.target === m) closeModal(m.id);
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
      rounds[ri].parts[si] = next;
      if (autoFill) autoFillRound(ri);
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

  function initFilters() {
    const group = $("#filterGroup");
    group.innerHTML =
      `<button type="button" class="filter-btn active" id="filterAll">全選</button>` +
      ATTRS.map(
        (a) =>
          `<button type="button" class="filter-btn" data-attr="${a}">${a}</button>`
      ).join("");
  }

  function init() {
    initFilters();
    initTypeSelector();
    initShipLimitSelector();
    rounds = [emptyRound()];
    bindStatic();
    renderAll();
    renderPresetList();

    if (!localStorage.getItem(HELP_KEY)) {
      openModal("helpModal");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

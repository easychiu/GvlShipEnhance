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

  /** 純帆（槳力上限 0）用六邊形；否則七邊形 */
  function isPureSailProfile() {
    return getAttrLimit("槳力") === 0;
  }

  function chartAttrs() {
    if (isPureSailProfile()) return ATTRS.filter((a) => a !== "槳力");
    return ATTRS.slice();
  }

  /** 仍可強化的屬性（只有達/超上限的不能強，其他照常） */
  function enhanceableAttrs(totals) {
    return ATTRS.filter((a) => canEnhanceAttr(totals[a] || 0, a));
  }

  /**
   * 本輪選零件時的「主攻」屬性（已封的排除，不整輪停掉）
   */
  function strategyFocusAttrs(totals, strategy) {
    const open = enhanceableAttrs(totals);
    if (!open.length) return [];

    const priOpen = open.filter((a) => isAutoAllocTarget(a));
    const limitedOpen = open.filter((a) => getAttrLimit(a) != null);

    switch (strategy.id) {
      case "burst":
      case "park":
      case "balanced":
        if (priOpen.length) return priOpen;
        return limitedOpen.length ? limitedOpen : open;
      case "all-limit":
        return limitedOpen.length ? limitedOpen : open;
      case "tank": {
        const tank = ["船耐", "護甲", "抗浪"].filter((a) => open.includes(a));
        if (priOpen.length) return priOpen;
        if (tank.length) return tank;
        return limitedOpen.length ? limitedOpen : open;
      }
      default:
        return priOpen.length ? priOpen : open;
    }
  }

  function strategyWeight(attr, strategy, totals) {
    const pri = getAutoPriority(attr);
    const basePri = pri != null ? 1 / pri : 0.15;
    const lim = getAttrLimit(attr);
    const p = totals[attr] || 0;
    const remain =
      lim != null ? Math.max(0, lim - p) : 50;

    switch (strategy.id) {
      case "park":
      case "burst":
        return isAutoAllocTarget(attr) ? basePri * 3 : basePri * 0.4;
      case "balanced":
        return isAutoAllocTarget(attr) ? 1 : 0.2;
      case "all-limit":
        return (isAutoAllocTarget(attr) ? basePri * 2 : 0.5) * (1 + remain / 100);
      case "tank": {
        const tankBoost =
          attr === "船耐" ? 2.2 : attr === "護甲" ? 1.8 : attr === "抗浪" ? 1.5 : 1;
        return (
          (isAutoAllocTarget(attr) ? basePri * 2.5 : 0.35) * tankBoost
        );
      }
      default:
        return basePri;
    }
  }

  function scoreFixedFour(partIds, totals, roundsLeft, strategy) {
    const cap = roundPartCap({ parts: partIds });
    const focus = strategyFocusAttrs(totals, strategy);
    if (!focus.length) return { valid: false, score: -1, cap };

    const usePark = strategy.id !== "burst";
    let score = 0;
    let valid = true;

    for (const a of focus) {
      const P = totals[a] || 0;
      const L = getAttrLimit(a);
      const C = cap[a] || 0;
      const w = strategyWeight(a, strategy, totals);
      if (L == null) {
        score += C * w * 50;
        continue;
      }
      const roomUnder = L - 1 - P;
      const park = usePark && roundsLeft > 1 && roomUnder > 0;
      if (park) {
        if (P + C > L - 1) {
          valid = false;
          break;
        }
        score += C * w * 100;
        score += (C / Math.max(roomUnder, 1)) * w * 40;
      } else {
        score += C * w * 250;
        if (P + C >= L) score += (P + C - L) * w * 20;
      }
    }
    // 輕微獎勵其它仍可強化屬性的順便加成
    for (const a of enhanceableAttrs(totals)) {
      if (focus.includes(a)) continue;
      score += (cap[a] || 0) * strategyWeight(a, strategy, totals) * 8;
    }
    return { valid, score, cap };
  }

  function pickBestFourParts(totals, roundsLeft, strategy) {
    const all = Object.values(PARTS);
    const n = all.length;
    let best = null;
    let bestScore = -Infinity;
    let fallback = null;
    let fallbackScore = -Infinity;
    const focus = strategyFocusAttrs(totals, strategy);

    for (let i = 0; i < n - 3; i++) {
      for (let j = i + 1; j < n - 2; j++) {
        for (let k = j + 1; k < n - 1; k++) {
          for (let l = k + 1; l < n; l++) {
            const ids = [all[i].id, all[j].id, all[k].id, all[l].id];
            const { valid, score, cap } = scoreFixedFour(
              ids,
              totals,
              roundsLeft,
              strategy
            );
            if (valid && score > bestScore) {
              bestScore = score;
              best = ids;
            }
            let fb = 0;
            for (const a of focus) {
              fb += (cap[a] || 0) * strategyWeight(a, strategy, totals);
            }
            if (fb > fallbackScore) {
              fallbackScore = fb;
              fallback = ids;
            }
          }
        }
      }
    }
    return best || fallback;
  }

  const AUTO_STRATEGIES = [
    {
      id: "park",
      name: "穩健堆疊",
      desc: "優先屬性先貼上限前一檔再超限；其餘未封屬性繼續配完次數",
    },
    {
      id: "burst",
      name: "激進決勝",
      desc: "每輪最大化優先屬性加成，較早超限拉開差距",
    },
    {
      id: "balanced",
      name: "優先均衡",
      desc: "有填優先的屬性盡量齊頭並進，避免單一屬性吃光輪次",
    },
    {
      id: "all-limit",
      name: "全上限兼顧",
      desc: "所有有設上限且未封的屬性一併納入，優先仍略重",
    },
    {
      id: "tank",
      name: "生存向",
      desc: "優先後偏重船耐／護甲／抗浪，偏坦度配置",
    },
  ];

  /**
   * 模擬一組策略 → 完整輪次與最終總值。
   * 規則：只有「該屬性」達/超上限才停該屬性；其它照強，盡量用光次數。
   */
  function simulateAutoPlan(strategy, maxR) {
    let totals = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const planRounds = [];

    for (let r = 0; r < maxR; r++) {
      const roundsLeft = maxR - r;
      const open = enhanceableAttrs(totals);
      // 沒有任何屬性能再強才停
      if (!open.length) break;

      const chosen = pickBestFourParts(totals, roundsLeft, strategy);
      if (!chosen || chosen.length !== SLOTS) break;

      const round = emptyRound();
      round.parts = chosen.slice();
      const cap = roundPartCap(round);
      const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));

      for (const a of ATTRS) {
        // 僅略過已達/超上限的屬性
        if (!canEnhanceAttr(totals[a] || 0, a)) {
          delta[a] = 0;
        } else {
          delta[a] = cap[a] || 0;
        }
        totals[a] = (totals[a] || 0) + delta[a];
      }

      if (!ATTRS.some((a) => (delta[a] || 0) > 0)) break;

      if (cumulativeMode) {
        round.values = { ...totals };
      } else {
        round.values = { ...delta };
      }
      round.note = `${strategy.name} #${r + 1}`;
      planRounds.push(round);
    }

    return {
      strategy,
      rounds: planRounds,
      totals: { ...totals },
      roundCount: planRounds.length,
    };
  }

  function buildRadarSvg(totals) {
    const axes = chartAttrs();
    const n = axes.length;
    const size = 168;
    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.34;
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
      grids += `<polygon points="${pts}" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>`;
    }

    let spokes = "";
    let labels = "";
    let dataPts = [];
    axes.forEach((a, i) => {
      const [x1, y1] = toXY(i, 1);
      spokes += `<line x1="${cx}" y1="${cy}" x2="${x1}" y2="${y1}" stroke="rgba(0,0,0,0.1)" stroke-width="1"/>`;
      const lim = getAttrLimit(a);
      const val = totals[a] || 0;
      const maxV = Math.max(lim != null && lim > 0 ? lim : 0, val, 1);
      const ratio = val / maxV;
      const [px, py] = toXY(i, ratio);
      dataPts.push(`${px},${py}`);
      const [lx, ly] = toXY(i, 1.22);
      const reached = lim != null && val >= lim && lim > 0;
      labels += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="${
        reached ? "#c92a2a" : "#334"
      }" font-weight="${reached ? "700" : "600"}">${SHORT[a]}</text>`;
    });

    const poly = dataPts.join(" ");
    return `<svg class="radar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      ${grids}${spokes}
      <polygon points="${poly}" fill="rgba(43,108,176,0.28)" stroke="#2b6cb0" stroke-width="2" stroke-linejoin="round"/>
      ${labels}
    </svg>`;
  }

  function formatPlanStats(totals, roundCount, maxR) {
    const axes = chartAttrs();
    const bits = axes.map((a) => {
      const v = totals[a] || 0;
      const lim = getAttrLimit(a);
      const mark = lim != null && v >= lim && lim > 0 ? "✓" : "";
      return `${SHORT[a]}${v}${mark}`;
    });
    return `<div class="plan-stats">輪次 <b>${roundCount}</b>／${maxR}<br/>${bits.join(
      " · "
    )}</div>`;
  }

  /** @type {ReturnType<typeof simulateAutoPlan>[]} */
  let pendingAutoPlans = [];

  function openAutoPlanModal(plans, maxR) {
    pendingAutoPlans = plans;
    const list = $("#autoPlanList");
    if (!list) return;
    const shape = isPureSailProfile() ? "六邊形（純帆）" : "七邊形";
    list.innerHTML = plans
      .map((plan, idx) => {
        const s = plan.strategy;
        return `<button type="button" class="auto-plan-card" data-plan-idx="${idx}">
          <h4>${escapeAttr(s.name)}</h4>
          <p class="plan-desc">${escapeAttr(s.desc)}</p>
          ${buildRadarSvg(plan.totals)}
          ${formatPlanStats(plan.totals, plan.roundCount, maxR)}
          <span class="plan-pick btn-primary" style="display:block;padding:6px 8px;border-radius:8px;font-size:13px">選擇此方案</span>
        </button>`;
      })
      .join("");

    const intro = document.querySelector(".auto-plan-intro");
    if (intro) {
      intro.textContent = `雷達為${shape}（相對各屬性上限；紅字軸＝已達上限）。僅已達／超過上限的屬性不能再強，其餘與剩餘次數會繼續配。點選方案回填主表。`;
    }

    openModal("autoPlanModal");
  }

  function applyAutoPlan(plan) {
    if (!plan || !plan.rounds?.length) {
      toast("方案無效");
      return;
    }
    rounds = plan.rounds.map((r) => ({
      parts: r.parts.slice(),
      values: { ...r.values },
      locks: { ...r.locks },
      note: r.note || "",
    }));
    closeModal("autoPlanModal");
    pendingAutoPlans = [];
    renderAll();
    toast(`已套用「${plan.strategy.name}」（${plan.roundCount} 輪）`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /**
   * 自動配：產生多組方案 → 彈窗選雷達圖 → 回填主表
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
      toast("請至少設定一組「上限」+「優先」（優先留白表示不列入自動配參考）");
      return;
    }

    toast("正在計算多組方案…");

    // 讓 toast 先畫出來
    setTimeout(() => {
      const plans = [];
      const seen = new Set();
      for (const strategy of AUTO_STRATEGIES) {
        const plan = simulateAutoPlan(strategy, maxR);
        if (!plan.rounds.length) continue;
        if (plan.rounds.some((r) => !isPartsComplete(r))) continue;
        const sig = plan.rounds
          .map((r) => r.parts.join("-") + ":" + ATTRS.map((a) => r.values[a]).join(","))
          .join("|");
        if (seen.has(sig)) continue;
        seen.add(sig);
        plans.push(plan);
      }

      if (!plans.length) {
        toast("無法自動配置：請檢查上限、優先與零件資料");
        return;
      }

      openAutoPlanModal(plans, maxR);
    }, 30);
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

        const partsOk = isPartsComplete(round);
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

    $("#autoPlanClose")?.addEventListener("click", () =>
      closeModal("autoPlanModal")
    );
    $("#autoPlanCancel")?.addEventListener("click", () =>
      closeModal("autoPlanModal")
    );
    $("#autoPlanList")?.addEventListener("click", (e) => {
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

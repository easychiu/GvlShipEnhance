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

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
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

  /**
   * 單屬性「決勝一擊」最大零件加成（4 件不重複全搜尋）
   * 達上限後不能再強，超限只靠這一輪 → 此值即單軸最大可能超限加成。
   */
  function computeMaxBurst(attr) {
    let bestIds = null;
    let bestC = -1;
    forEachFourCombo((ids, cap) => {
      const c = cap[attr] || 0;
      if (c > bestC) {
        bestC = c;
        bestIds = ids.slice();
      }
    });
    return { parts: bestIds, burst: Math.max(0, bestC) };
  }

  /** 堆疊：4 件加滿後該屬性增量 ≤ roomUnder，並盡量大 */
  function pickParkPartsForAttr(attr, roomUnder) {
    if (roomUnder <= 0) return null;
    let bestIds = null;
    let bestC = -1;
    forEachFourCombo((ids, cap) => {
      const c = cap[attr] || 0;
      if (c > 0 && c <= roomUnder && c > bestC) {
        bestC = c;
        bestIds = ids.slice();
      }
    });
    if (!bestIds) return null;
    return { parts: bestIds, cap: bestC };
  }

  /**
   * 單軸最大決勝方案：逐屬性「堆到上限-1 → 用 maxBurst 決勝」。
   * 決勝輪對該屬性保證是全搜尋最大 4 件加成。
   */
  function simulateProvenMaxBurst(order, maxR, strategyMeta) {
    const totals = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const planRounds = [];
    const burstMap = {};
    for (const a of order) {
      burstMap[a] = computeMaxBurst(a);
    }

    const applyParts = (parts, note) => {
      if (!parts || parts.length !== SLOTS) return false;
      if (planRounds.length >= maxR) return false;
      const round = emptyRound();
      round.parts = parts.slice();
      const cap = roundPartCap(round);
      const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));
      for (const a of ATTRS) {
        if (!canEnhanceAttr(totals[a] || 0, a)) {
          delta[a] = 0;
        } else {
          delta[a] = cap[a] || 0;
        }
        totals[a] = (totals[a] || 0) + delta[a];
      }
      if (!ATTRS.some((a) => (delta[a] || 0) > 0)) return false;
      if (cumulativeMode) round.values = { ...totals };
      else round.values = { ...delta };
      round.note = note;
      planRounds.push(round);
      return true;
    };

    for (const attr of order) {
      const L = getAttrLimit(attr);
      if (L == null) continue;
      const burstInfo = burstMap[attr];
      if (!burstInfo?.parts) continue;

      while (planRounds.length < maxR && canEnhanceAttr(totals[attr] || 0, attr)) {
        const P = totals[attr] || 0;
        const roomUnder = L - 1 - P;
        const roundsLeft = maxR - planRounds.length;

        // 最後一輪或已在上限前一檔 → 最大決勝
        if (roundsLeft <= 1 || roomUnder <= 0) {
          const ok = applyParts(
            burstInfo.parts,
            `${strategyMeta.name} · ${attr}決勝(最大+${burstInfo.burst})`
          );
          if (!ok) break;
          continue;
        }

        // 堆疊：貼近上限-1
        const park = pickParkPartsForAttr(attr, roomUnder);
        if (park && park.cap > 0) {
          const ok = applyParts(
            park.parts,
            `${strategyMeta.name} · ${attr}堆疊(+${park.cap}→貼前檔)`
          );
          if (!ok) break;
          // 若加完仍未到前檔且還有輪，繼續迴圈
          continue;
        }

        // 找不到合法堆疊 4 件（增量都會超過前檔）→ 直接決勝
        const ok = applyParts(
          burstInfo.parts,
          `${strategyMeta.name} · ${attr}決勝(最大+${burstInfo.burst})`
        );
        if (!ok) break;
      }
    }

    return {
      strategy: strategyMeta,
      rounds: planRounds,
      totals: { ...totals },
      roundCount: planRounds.length,
    };
  }

  /**
   * 只依「使用者填的優先」產生多組自動配策略（排列組合）。
   * 例：護甲1／船耐1／轉向1 → 均衡超限 + 偏重各軸 + 不同攻頂順序
   */
  function buildUserPriorityStrategies() {
    const targets = userPriorityAttrs();
    if (!targets.length) return [];

    const priLabel = targets
      .map((a) => `${SHORT[a]}${getAutoPriority(a)}`)
      .join("·");
    const strategies = [];
    const push = (s) => strategies.push(s);

    // 權重：數字愈小愈重；同為 1 則等權 → 都想盡量超限
    const weightByPri = () => {
      const w = {};
      for (const a of targets) w[a] = 1 / getAutoPriority(a);
      return w;
    };
    const weightFocus = (focusAttr) => {
      const w = weightByPri();
      for (const a of targets) {
        w[a] = a === focusAttr ? (w[a] || 1) * 4.5 : (w[a] || 1) * 0.85;
      }
      return w;
    };
    const weightSerial = (order) => {
      const w = {};
      order.forEach((a, i) => {
        w[a] = 1 / (i + 1);
      });
      return w;
    };

    // ★ 單軸最大決勝（可證明決勝輪 = 全搜尋最大 4 件加成）
    push({
      id: "proven-max-burst",
      name: "★ 單軸最大決勝",
      desc: `逐軸堆到上限前一檔，決勝用全搜尋最大 4 件（${priLabel}）；單軸超限加成保證最大`,
      mode: "proven",
      order: targets.slice(),
    });

    if (targets.length >= 2 && targets.length <= 3) {
      for (const order of permutations(targets)) {
        // 與預設順序相同的略過（上面已有）
        if (order.join("-") === targets.join("-")) continue;
        push({
          id: `proven-max-${order.join("-")}`,
          name: `★ 最大決勝 ${order.map((a) => SHORT[a]).join("→")}`,
          desc: `單軸最大決勝，順序：${order.join(" → ")}`,
          mode: "proven",
          order: order.slice(),
        });
      }
    }

    // ★ 嚴格超限：啟發式（多輪貪婪）
    push({
      id: "strict-overshoot",
      name: "★ 嚴格超限",
      desc: `逐項先貼上限前一檔，再用最大 4 零件一口氣超限（${priLabel}），超限值越高越好`,
      mode: "serial",
      usePark: true,
      maximizeOvershoot: true,
      order: targets.slice(),
      weights: weightSerial(targets),
    });

    push({
      id: "strict-overshoot-sync",
      name: "★ 嚴格超限（同步）",
      desc: `優先屬性同步貼上限前一檔，再一起用最大加成超限（${priLabel}）`,
      mode: "parallel",
      usePark: true,
      maximizeOvershoot: true,
      weights: weightByPri(),
    });

    // 嚴格超限 × 不同攻頂順序（2～3 個優先時）
    if (targets.length >= 2 && targets.length <= 3) {
      for (const order of permutations(targets)) {
        push({
          id: `strict-order-${order.join("-")}`,
          name: `★ 嚴格 ${order.map((a) => SHORT[a]).join("→")}`,
          desc: `嚴格超限順序：${order.join(" → ")}（每項貼前檔再最大決勝）`,
          mode: "serial",
          usePark: true,
          maximizeOvershoot: true,
          order: order.slice(),
          weights: weightSerial(order),
        });
      }
    }

    push({
      id: "sync-burst",
      name: "同步超限",
      desc: `依你的優先（${priLabel}）齊頭拉高，盡量超過上限`,
      mode: "parallel",
      usePark: false,
      weights: weightByPri(),
    });

    push({
      id: "sync-park",
      name: "同步穩健",
      desc: `優先屬性先貼上限前一檔，再一口氣超限（${priLabel}）`,
      mode: "parallel",
      usePark: true,
      weights: weightByPri(),
    });

    // 同優先或整體：偏重某一軸的組合
    if (targets.length >= 2) {
      for (const focus of targets) {
        push({
          id: `bias-${focus}`,
          name: `偏重${focus}`,
          desc: `在你的優先裡多堆「${focus}」超限，其餘優先仍會顧`,
          mode: "parallel",
          usePark: false,
          weights: weightFocus(focus),
        });
      }
    }

    // 依優先數字分層攻頂（1 做完再 2…）
    push({
      id: "tier-serial",
      name: "分層攻頂",
      desc: "先做完較小優先數字，再往下一層（例：全是1則等同齊頭）",
      mode: "tier",
      usePark: false,
      weights: weightByPri(),
    });

    // 同層多屬性：排列攻頂順序（2～3 項會展開；更多則取前幾組）
    const byTier = new Map();
    for (const a of targets) {
      const p = getAutoPriority(a);
      if (!byTier.has(p)) byTier.set(p, []);
      byTier.get(p).push(a);
    }
    let permBudget = 6;
    for (const [, group] of byTier) {
      if (group.length < 2 || group.length > 3) continue;
      const perms = permutations(group);
      for (const order of perms) {
        if (permBudget-- <= 0) break;
        // 本層排列在前，其它優先層維持使用者順序接在後
        const rest = targets.filter((a) => !group.includes(a));
        const serialOrder = order.concat(rest);
        push({
          id: `order-${serialOrder.join("-")}`,
          name: `順序 ${order.map((a) => SHORT[a]).join("→")}`,
          desc: `攻頂順序：${serialOrder.join(" → ")}（盡量超限）`,
          mode: "serial",
          usePark: false,
          order: serialOrder,
          weights: weightSerial(serialOrder),
        });
      }
    }

    // 整體 serial 依使用者數字（若上面沒產出重複的）
    if (targets.length >= 2) {
      push({
        id: "pri-serial",
        name: "依優先序",
        desc: `嚴格 ${targets.map((a) => a + getAutoPriority(a)).join(" → ")}`,
        mode: "serial",
        usePark: true,
        order: targets.slice(),
        weights: weightSerial(targets),
      });
    }

    return strategies;
  }

  /** 本輪主攻：只看使用者優先且未封 */
  function strategyFocusAttrs(totals, strategy) {
    const priOpen = enhanceableAttrs(totals)
      .filter((a) => isAutoAllocTarget(a))
      .sort((a, b) => getAutoPriority(a) - getAutoPriority(b));

    if (!priOpen.length) return [];

    if (strategy.mode === "serial" && Array.isArray(strategy.order)) {
      const next = strategy.order.find((a) => priOpen.includes(a));
      return next ? [next] : [];
    }
    if (strategy.mode === "tier") {
      const top = Math.min(...priOpen.map((a) => getAutoPriority(a)));
      return priOpen.filter((a) => getAutoPriority(a) === top);
    }
    // parallel：所有未封的使用者優先
    return priOpen;
  }

  function strategyWeight(attr, strategy) {
    if (!isAutoAllocTarget(attr)) return 0.01;
    if (strategy.weights && strategy.weights[attr] != null) {
      return strategy.weights[attr];
    }
    return 1 / getAutoPriority(attr);
  }

  function scoreFixedFour(partIds, totals, roundsLeft, strategy) {
    const cap = roundPartCap({ parts: partIds });
    const focus = strategyFocusAttrs(totals, strategy);
    if (!focus.length) return { valid: false, score: -1, cap };

    const usePark = !!strategy.usePark;
    const maxOver = !!strategy.maximizeOvershoot;
    let score = 0;
    let valid = true;

    for (const a of focus) {
      const P = totals[a] || 0;
      const L = getAttrLimit(a);
      const C = cap[a] || 0;
      const w = strategyWeight(a, strategy);
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
        // 堆疊：盡量貼近上限前一檔，為決勝留最大一擊
        score += C * w * (maxOver ? 90 : 100);
        const close = 1 - (roomUnder - C) / Math.max(roomUnder, 1);
        score += Math.max(0, close) * w * (maxOver ? 120 : 40);
        if (maxOver && P + C === L - 1) score += w * 200;
      } else {
        // 決勝：嚴格最大化「超限值」與本輪加成
        const after = P + C;
        const over = Math.max(0, after - L);
        if (maxOver) {
          score += C * w * 500;
          score += over * w * 1200;
          // 從上限前一檔（或極接近）出發再加分
          if (P >= L - 1) score += C * w * 400;
          else if (P < L) score += over * w * 200;
        } else {
          score += C * w * 250;
          if (after >= L) score += (over + 1) * w * 35;
        }
      }
    }

    // 懲罰非優先順便成長（嚴格超限時懲罰更重）
    const pen = maxOver ? 22 : 14;
    for (const a of enhanceableAttrs(totals)) {
      if (isAutoAllocTarget(a)) continue;
      score -= (cap[a] || 0) * pen;
    }
    return { valid, score, cap };
  }

  function pickBestFourParts(totals, roundsLeft, strategy) {
    const all = Object.values(PARTS).filter(
      (p) => !(isPureSailProfile() && isPaddlePart(p))
    );
    const n = all.length;
    if (n < SLOTS) return null;
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
              fb += (cap[a] || 0) * strategyWeight(a, strategy);
            }
            // 後備也略懲罰非優先
            for (const a of ATTRS) {
              if (!isAutoAllocTarget(a)) fb -= (cap[a] || 0) * 0.15;
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

  /**
   * 模擬一組策略 → 完整輪次與最終總值。
   * 只服務使用者優先；單一屬性達/超上限則該屬性停，其餘優先繼續。
   */
  function simulateAutoPlan(strategy, maxR) {
    if (strategy.mode === "proven") {
      const order =
        Array.isArray(strategy.order) && strategy.order.length
          ? strategy.order
          : userPriorityAttrs();
      return simulateProvenMaxBurst(order, maxR, strategy);
    }

    let totals = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const planRounds = [];

    for (let r = 0; r < maxR; r++) {
      const roundsLeft = maxR - r;
      const focus = strategyFocusAttrs(totals, strategy);
      if (!focus.length) break;

      const chosen = pickBestFourParts(totals, roundsLeft, strategy);
      if (!chosen || chosen.length !== SLOTS) break;

      const round = emptyRound();
      round.parts = chosen.slice();
      const cap = roundPartCap(round);
      const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));

      for (const a of ATTRS) {
        if (!canEnhanceAttr(totals[a] || 0, a)) {
          delta[a] = 0;
        } else {
          delta[a] = cap[a] || 0;
        }
        totals[a] = (totals[a] || 0) + delta[a];
      }

      if (!focus.some((a) => (delta[a] || 0) > 0)) break;

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

  function formatPlanStats(totals, roundCount, maxR) {
    const axes = chartAttrs();
    const bits = axes.map((a) => {
      const v = totals[a] || 0;
      const lim = getAttrLimit(a);
      const mark = lim != null && v >= lim && lim > 0 ? "✓" : "";
      return `${SHORT[a]}${v}${mark}`;
    });
    // 優先屬性超限合計（越高越好）
    let overSum = 0;
    const overBits = [];
    for (const a of userPriorityAttrs()) {
      const lim = getAttrLimit(a);
      const v = totals[a] || 0;
      if (lim != null && v > lim) {
        const o = v - lim;
        overSum += o;
        overBits.push(`${SHORT[a]}+${o}`);
      }
    }
    const overLine =
      overSum > 0
        ? `<br/><span style="color:#c92a2a">超限合計 <b>${overSum}</b>${
            overBits.length ? `（${overBits.join(" ")}）` : ""
          }</span>`
        : "";
    return `<div class="plan-stats">輪次 <b>${roundCount}</b>／${maxR}<br/>${bits.join(
      " · "
    )}${overLine}</div>`;
  }

  /** @type {ReturnType<typeof simulateAutoPlan>[]} */
  let pendingAutoPlans = [];

  function openAutoPlanModal(plans, maxR) {
    pendingAutoPlans = plans;
    const list = $("#autoPlanList");
    if (!list) return;
    const shape = isPureSailProfile() ? "六邊形（純帆）" : "七邊形";
    const priHint = userPriorityAttrs()
      .map((a) => `${a}${getAutoPriority(a)}`)
      .join("／");

    list.innerHTML = plans
      .map((plan, idx) => {
        const s = plan.strategy;
        return `<button type="button" class="auto-plan-card plan-user" data-plan-idx="${idx}">
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
      intro.textContent = `全部依你的優先產生組合（目前：${
        priHint || "未設定"
      }）。同填 1＝都想盡量超限。雷達${shape}；紅字軸＝已達上限。點選後回填主表。`;
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

    toast("正在依你的優先計算組合方案…");

    setTimeout(() => {
      const strategies = buildUserPriorityStrategies();
      const plans = [];
      const seen = new Set();
      for (const strategy of strategies) {
        const plan = simulateAutoPlan(strategy, maxR);
        if (!plan.rounds.length) continue;
        if (plan.rounds.some((r) => !isPartsComplete(r))) continue;
        // 用最終總值簽名去重（不同順序若結果相同只留一個）
        const sig = ATTRS.map((a) => plan.totals[a] || 0).join(",");
        if (seen.has(sig)) continue;
        seen.add(sig);
        plans.push(plan);
      }

      // 超限合計高的在前；單軸最大決勝再略加權
      plans.sort((p, q) => {
        const over = (plan) => {
          let s = 0;
          for (const a of userPriorityAttrs()) {
            const lim = getAttrLimit(a);
            const v = plan.totals[a] || 0;
            if (lim != null && v > lim) s += v - lim;
          }
          if (plan.strategy.mode === "proven") s += 0.5;
          else if (plan.strategy.maximizeOvershoot) s += 0.01;
          return s;
        };
        return over(q) - over(p);
      });

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
    // 純帆：清槳零件／槳優先，介面不出現槳可選
    if (isPureSailProfile()) stripPaddleForPureSail();
    renderAll();
    syncShipLimitSelector();
    if (!silent) {
      const pure = ship.pureSail || ship.limits.槳力 === 0 ? "（純帆·無槳可選）" : "";
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
    const pure = isPureSailProfile();
    let list = Object.values(PARTS);
    // 純帆：不可選有槳力加成的零件
    if (pure) list = list.filter((p) => !isPaddlePart(p));
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
    // 篩選時仍保留目前已選但不符條件的零件（純帆不保留槳零件）
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

        const attrItems = uiAttrs().map((a) => {
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

    $("#filterGroup")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn || !e.currentTarget.contains(btn)) return;
      if (btn.id === "filterAll") setFilter(null, btn);
      else if (btn.dataset.attr) setFilter(btn.dataset.attr, btn);
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
      // 純帆不可選槳零件
      if (next !== "" && isPureSailProfile() && isPaddlePart(next)) {
        toast("純帆船不可選擇槳力零件");
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
    renderFilters();
    renderAll();
    renderPresetList();

    if (!localStorage.getItem(HELP_KEY)) {
      openModal("helpModal");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

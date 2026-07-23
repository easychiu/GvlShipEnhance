/**
 * 大航海傳說 · 船隻強化模擬器 — 自動配 1.0 啟發式引擎（移植回歸）
 *
 * 純函式模組：同輸入必同輸出，不碰 DOM／window 以外任何全域。
 * 內容移植自 2.0 精確求解器上線前最終版 app.js（git 6abc1b4，含可達頂與 tiebreak 修正），
 * 原本掛在 app.js 模組作用域內、讀取一堆頁面全域狀態（maxLimit／attrPriority／cumulativeMode…）；
 * 這裡改成每次 solve() 呼叫時由 input 建立獨立的 per-solve 上下文，彼此不共用可變狀態。
 *
 * 策略邏輯（多輪貪婪＋排列組合＋各種攻頂／堆疊／超限即停變體）與原版逐函式對應，
 * 僅拿掉三個 UI 專屬概念：
 *   - round.values／round.locks：舊版依 cumulativeMode 決定顯示「累計」或「本輪增量」，
 *     這是頁面顯示狀態，模組不涉及；呼叫端（app.js 的 objectifyRawPlan）會依現行規則重建。
 *   - cumulativeMode 本身：同上，模組沒有這個全域可讀，相關分支整段拿掉。
 *   - SHORT（屬性簡稱，如「轉」／「甲」）：不在 solve() 的 input 契約內（與 AutoAlloc.solve
 *     完全相同的 8 個欄位），策略 name／desc 內原本用簡稱的地方一律改用完整屬性名。
 *
 * 移植時發現並修正一個原始碼即有的 bug（simulateAutoPlan 泛用分支／
 * simulatePriorityOvershootStop／simulateMinRoundsPriorityStop 三處）：原版「先把整輪加成
 * 寫回 totals、才判斷這輪要不要採用」，round 被拒時 totals 已被非優先屬性的增量污染，
 * 回傳的 totals 會多算一輪沒被記錄進 rounds 的幽靈增量。改為「先算 delta、判斷通過才寫回
 * totals」，任何被拒的 round 對 totals 恆零副作用；不影響已採用 round 的挑選順序或內容，
 * 只讓「重放 rounds === plan.totals」這條合法性不變式在所有分支都成立。
 *
 * 遊戲規則（與 AutoAlloc.solve 一致）：
 * - 每輪選 4 個互不相同零件，該輪各屬性增量 = 4 件加成總和
 * - 屬性目前累計 < 上限 L → 本輪整輪加成吃滿（可一次衝超過 L）；累計 ≥ L → 封印，之後增量恆 0
 *
 * @param {object} input 形狀與 AutoAlloc.solve 完全相同：
 *   { parts, attrs, limits, priorities, budget, startTotals, pureSail, slots }
 * @returns {{ plans: Array<{id:string,name:string,desc:string,legacyMode:string,
 *   rounds:(string|number)[][], totals:Record<string,number>, roundCount:number}>,
 *   stats: { ms:number, strategiesTried:number } }}
 *   plans 已依舊版邏輯排序＋內部去重（sig=策略id+totals+輪數），最多 30 筆；
 *   rounds 只有零件 id 陣列（不含 values/locks），由呼叫端物件化重建顯示值。
 */
(() => {
  "use strict";

  function solve(input) {
    const t0 = Date.now();
    const ATTRS = input.attrs;
    const PARTS = input.parts;
    const SLOTS = input.slots || 4;
    const limitsIn = input.limits || {};
    const prioritiesIn = input.priorities || {};
    const budget = Math.max(1, Math.min(30, input.budget | 0 || 1));
    const startTotals =
      input.startTotals || Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const pureSail = !!input.pureSail;

    // ===================== per-solve 上下文（取代舊版頁面全域狀態）=====================

    /** 屬性是否有設定有效上限 */
    function getAttrLimit(attr) {
      const raw = limitsIn[attr];
      if (raw === "" || raw == null) return null;
      const lim = Number(raw);
      if (!Number.isFinite(lim) || lim < 0) return null;
      return lim;
    }

    /** 有填有效優先數字才參與自動配（空白／null＝不列入） */
    function getAutoPriority(attr) {
      const raw = prioritiesIn[attr];
      if (raw === "" || raw == null) return null;
      const p = Number(raw);
      if (!Number.isFinite(p) || p <= 0) return null;
      return p;
    }

    /** isAutoAllocTarget 語意＝priorities[a]!=null 且 limits[a]!=null（與舊版一致） */
    function isAutoAllocTarget(attr) {
      return getAttrLimit(attr) != null && getAutoPriority(attr) != null;
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

    /** 有槳力加成的零件（純帆不可選） */
    function isPaddlePart(partOrId) {
      const p =
        typeof partOrId === "object" && partOrId
          ? partOrId
          : PARTS[String(partOrId)];
      return !!(p && (p.bonus["槳力"] || 0) > 0);
    }

    /** 使用者有填優先的屬性（排序：數字小→大，同序照 ATTRS） */
    function userPriorityAttrs() {
      return ATTRS.filter((a) => isAutoAllocTarget(a)).sort((a, b) => {
        const d = getAutoPriority(a) - getAutoPriority(b);
        return d !== 0 ? d : ATTRS.indexOf(a) - ATTRS.indexOf(b);
      });
    }

    /** 仍可強化的屬性（只有達/超上限的不能強，其他照常） */
    function enhanceableAttrs(totals) {
      return ATTRS.filter((a) => canEnhanceAttr(totals[a] || 0, a));
    }

    function emptyRound() {
      return { parts: Array(SLOTS).fill(""), note: "" };
    }

    /** 本輪是否已選滿 4 個不重複零件 */
    function isPartsComplete(round) {
      if (!round || !Array.isArray(round.parts)) return false;
      const filled = round.parts.filter((p) => p !== "" && p != null);
      if (filled.length !== SLOTS) return false;
      return new Set(filled.map(String)).size === SLOTS;
    }

    function roundPartCap(round) {
      const cap = Object.fromEntries(ATTRS.map((a) => [a, 0]));
      for (const id of round.parts) {
        if (!id) continue;
        const p = PARTS[String(id)];
        if (!p) continue;
        for (const a of ATTRS) cap[a] += p.bonus[a] || 0;
      }
      return cap;
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
        (p) => !(pureSail && isPaddlePart(p))
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

    /** 本次 solve 共用的 maxBurst 與 gains 快取（一次窮舉填多屬性；per-solve，呼叫間不殘留） */
    let maxBurstCache = null;
    let gainsCache = null;

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
      const start =
        typeof opts === "object" && opts && opts.start != null
          ? opts.start
          : 0;
      const bg =
        typeof opts === "object" && opts && opts.budget != null
          ? opts.budget
          : budget;
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
      const pre = reachablePre(attr, {
        start,
        parkRounds: Math.max(0, bg - 1),
      });
      const final = pre + burst;
      const over = Math.max(0, final - L);
      return { attr, limit: L, pre, burst, final, over, parts };
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
     * opts.startTotals / opts.maxNewRounds：接著既有配置時從目前總值繼續，只產出新輪次。
     */
    function simulateProvenMaxBurst(order, maxR, strategyMeta, opts = {}) {
      const st = opts.startTotals || startTotals;
      const maxNew = opts.maxNewRounds != null ? opts.maxNewRounds : maxR;
      const totals = { ...st };
      const planRounds = [];
      const burstMap = {};
      for (const a of order) {
        burstMap[a] = computeMaxBurst(a);
      }

      const applyParts = (parts, note) => {
        if (!parts || parts.length !== SLOTS) return false;
        if (planRounds.length >= maxNew) return false;
        const round = emptyRound();
        round.parts = parts.slice();
        const cap = roundPartCap(round);
        const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));
        for (const a of ATTRS) {
          delta[a] = canEnhanceAttr(totals[a] || 0, a) ? cap[a] || 0 : 0;
          totals[a] = (totals[a] || 0) + delta[a];
        }
        if (!ATTRS.some((a) => (delta[a] || 0) > 0)) return false;
        round.note = note;
        planRounds.push(round);
        return true;
      };

      for (const attr of order) {
        const L = getAttrLimit(attr);
        if (L == null) continue;
        const burstInfo = burstMap[attr];
        if (!burstInfo?.parts) continue;

        while (
          planRounds.length < maxNew &&
          canEnhanceAttr(totals[attr] || 0, attr)
        ) {
          const P = totals[attr] || 0;
          const roomUnder = L - 1 - P;
          const roundsLeft = maxNew - planRounds.length;

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
            continue;
          }

          // 找不到合法堆疊 4 件 → 直接決勝
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
     * 優先超限即停：只衝有填優先的屬性，全部 ≥ 上限（超限/封頂）後立刻停止，
     * 不硬用完剩餘強化次數。
     * stopMode: "parallel" 同步衝｜"serial" 依優先序逐軸
     */
    function simulatePriorityOvershootStop(strategyMeta, maxR, opts = {}) {
      const st = opts.startTotals || startTotals;
      const maxNew = opts.maxNewRounds != null ? opts.maxNewRounds : maxR;
      const totals = { ...st };
      const planRounds = [];
      const order =
        Array.isArray(strategyMeta.order) && strategyMeta.order.length
          ? strategyMeta.order
          : userPriorityAttrs();
      const serial = strategyMeta.stopMode === "serial";

      const openPriority = () =>
        order.filter(
          (a) => isAutoAllocTarget(a) && canEnhanceAttr(totals[a] || 0, a)
        );

      const applyParts = (parts, note) => {
        if (!parts || parts.length !== SLOTS) return false;
        if (planRounds.length >= maxNew) return false;
        const round = emptyRound();
        round.parts = parts.slice();
        const cap = roundPartCap(round);
        const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));
        const focusNow = openPriority();
        for (const a of ATTRS) {
          delta[a] = canEnhanceAttr(totals[a] || 0, a) ? cap[a] || 0 : 0;
        }
        // 至少要有一項「當前優先目標」有增量，通過才寫回 totals：
        // ponytail-fix（原始 6abc1b4 版在此處「先加總、才判斷」，round 被拒時 totals 仍會被
        // 非優先屬性的增量污染，導致回傳 totals 多算一輪沒進 rounds 的幽靈增量，破壞重放一致性；
        // 移植時發現並修正，詳見回報「偏離」說明）
        if (!focusNow.some((a) => (delta[a] || 0) > 0)) return false;
        for (const a of ATTRS) {
          totals[a] = (totals[a] || 0) + delta[a];
        }
        round.note = note;
        planRounds.push(round);
        return true;
      };

      const pickForFocus = (focus) => {
        if (!focus.length) return null;
        let bestIds = null;
        let bestScore = -Infinity;
        let bestFocusGain = 0;
        forEachFourCombo((ids, cap) => {
          let s = 0;
          let focusGain = 0;
          for (const a of focus) {
            const C = cap[a] || 0;
            if (C <= 0) continue;
            focusGain += C;
            const P = totals[a] || 0;
            const L = getAttrLimit(a);
            const w = 1 / (getAutoPriority(a) || 1);
            s += C * w * 100;
            // 本輪能達/超上限者大加分（盡快走完優先）
            if (L != null && P + C >= L) s += (C + (P + C - L)) * w * 250;
          }
          // 必須對優先有增益，才考慮（避免分數被非優先懲罰打成 0 而整案失敗）
          if (focusGain <= 0) return;
          for (const a of ATTRS) {
            // ponytail: 0.001 使極端優先權重(1/99)下也壓不過最小真實差距
            if (!isAutoAllocTarget(a)) s += (cap[a] || 0) * 0.001;
          }
          if (
            s > bestScore ||
            (s === bestScore && focusGain > bestFocusGain)
          ) {
            bestScore = s;
            bestFocusGain = focusGain;
            bestIds = ids.slice();
          }
        });
        // 只要有對優先的增益就回傳，不要求 total score > 0
        return bestIds;
      };

      if (serial) {
        for (const attr of order) {
          while (
            planRounds.length < maxNew &&
            isAutoAllocTarget(attr) &&
            canEnhanceAttr(totals[attr] || 0, attr)
          ) {
            const parts = pickForFocus([attr]);
            if (!parts) break;
            const ok = applyParts(
              parts,
              `${strategyMeta.name} · ${attr}（超限即停）`
            );
            if (!ok) break;
          }
        }
      } else {
        while (planRounds.length < maxNew) {
          const focus = openPriority();
          // 有填優先的全部已達/超上限 → 立刻停
          if (!focus.length) break;
          const parts = pickForFocus(focus);
          if (!parts) break;
          const ok = applyParts(
            parts,
            `${strategyMeta.name} #${planRounds.length + 1}`
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
     * 最省次數·優先超限即停：
     * - 只衝有填優先的屬性
     * - 全部 ≥ 上限後立刻停
     * - 不追求極致超限，每輪優先「本輪能封掉幾軸」與「朝上限的有效進度」
     * stopMode: parallel | serial
     */
    function simulateMinRoundsPriorityStop(strategyMeta, maxR, opts = {}) {
      const st = opts.startTotals || startTotals;
      const maxNew = opts.maxNewRounds != null ? opts.maxNewRounds : maxR;
      const totals = { ...st };
      const planRounds = [];
      const order =
        Array.isArray(strategyMeta.order) && strategyMeta.order.length
          ? strategyMeta.order
          : userPriorityAttrs();
      const serial = strategyMeta.stopMode === "serial";

      const openPriority = (focusList) =>
        (focusList || order).filter(
          (a) => isAutoAllocTarget(a) && canEnhanceAttr(totals[a] || 0, a)
        );

      const applyParts = (parts, note, focusNow) => {
        if (!parts || parts.length !== SLOTS) return false;
        if (planRounds.length >= maxNew) return false;
        const round = emptyRound();
        round.parts = parts.slice();
        const cap = roundPartCap(round);
        const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));
        for (const a of ATTRS) {
          delta[a] = canEnhanceAttr(totals[a] || 0, a) ? cap[a] || 0 : 0;
        }
        // 通過才寫回 totals（ponytail-fix，同 simulatePriorityOvershootStop 說明）
        if (!focusNow.some((a) => (delta[a] || 0) > 0)) return false;
        for (const a of ATTRS) {
          totals[a] = (totals[a] || 0) + delta[a];
        }
        round.note = note;
        planRounds.push(round);
        return true;
      };

      /** 最省次數：先最大化「本輪能封掉的優先軸數」，再最大化朝上限的有效進度（不硬堆超限） */
      const pickMinRounds = (focus) => {
        if (!focus.length) return null;
        let bestIds = null;
        let bestKey = null; // [seals, progress, -waste]

        forEachFourCombo((ids, cap) => {
          let seals = 0;
          let progress = 0;
          let waste = 0;
          let focusGain = 0;
          for (const a of focus) {
            const C = cap[a] || 0;
            if (C > 0) focusGain += C;
            const P = totals[a] || 0;
            const L = getAttrLimit(a);
            if (L == null) {
              progress += C * 0.1;
              continue;
            }
            const need = Math.max(0, L - P); // 達上限至少還要多少
            if (need <= 0) continue;
            if (C >= need) {
              seals += 1;
              // 剛好或略超即可，多餘超限不鼓勵（省次數不必極致）
              waste += Math.max(0, C - need);
              progress += need * 10;
            } else if (C > 0) {
              progress += C * 8;
            }
          }
          if (focusGain <= 0 && seals === 0 && progress === 0) return;

          let nonPriGain = 0;
          for (const a of ATTRS) {
            if (!isAutoAllocTarget(a)) nonPriGain += cap[a] || 0;
          }

          const key = [seals, progress, -waste, nonPriGain];
          const better =
            !bestKey ||
            key[0] > bestKey[0] ||
            (key[0] === bestKey[0] && key[1] > bestKey[1]) ||
            (key[0] === bestKey[0] &&
              key[1] === bestKey[1] &&
              key[2] > bestKey[2]) ||
            (key[0] === bestKey[0] &&
              key[1] === bestKey[1] &&
              key[2] === bestKey[2] &&
              key[3] > bestKey[3]);
          if (better) {
            bestKey = key;
            bestIds = ids.slice();
          }
        });
        return bestIds;
      };

      if (serial) {
        for (const attr of order) {
          while (
            planRounds.length < maxNew &&
            isAutoAllocTarget(attr) &&
            canEnhanceAttr(totals[attr] || 0, attr)
          ) {
            const focus = [attr];
            // 單軸：優先選能一次封頂的最大有效進度組合
            let parts = pickMinRounds(focus);
            if (!parts) {
              // fallback：該軸 maxBurst
              const b = computeMaxBurst(attr);
              parts = b.parts;
            }
            if (!parts) break;
            const ok = applyParts(
              parts,
              `${strategyMeta.name} · ${attr}`,
              focus
            );
            if (!ok) break;
          }
        }
      } else {
        while (planRounds.length < maxNew) {
          const focus = openPriority();
          if (!focus.length) break; // 全部優先已超限 → 停
          const parts = pickMinRounds(focus);
          if (!parts) break;
          const ok = applyParts(
            parts,
            `${strategyMeta.name} #${planRounds.length + 1}`,
            focus
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
     * （原版用 SHORT 簡稱組字串顯示；模組 input 無 SHORT，一律改用完整屬性名）
     */
    function buildUserPriorityStrategies(bg, opts = {}) {
      const targets = userPriorityAttrs();
      if (!targets.length) return [];

      const priLabel = targets
        .map((a) => `${a}${getAutoPriority(a)}`)
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

      // ★ 最省次數·優先超限即停（不追求極致超限）
      push({
        id: "priority-stop-min-parallel",
        name: "★ 最省次數·優先超限即停",
        desc: `只衝優先（${priLabel}），全部達/超上限即停；每輪盡量多封軸，輪數最少，超限不必極致`,
        mode: "priority-stop-min",
        stopMode: "parallel",
        order: targets.slice(),
      });
      push({
        id: "priority-stop-min-serial",
        name: "★ 最省次數·依序即停",
        desc: `依優先序逐軸用最少輪達/超上限（${priLabel}），全做完即停`,
        mode: "priority-stop-min",
        stopMode: "serial",
        order: targets.slice(),
      });

      // ★ 優先超限即停：只配優先，全超限後停，不耗剩餘次數（衝較高超限）
      push({
        id: "priority-stop-parallel",
        name: "★ 優先超限即停",
        desc: `只衝有填優先（${priLabel}），全部達/超上限後立刻停止；偏高超限`,
        mode: "priority-stop",
        stopMode: "parallel",
        order: targets.slice(),
      });
      push({
        id: "priority-stop-serial",
        name: "★ 優先超限即停（依序）",
        desc: `依優先序逐軸衝到超限再下一軸（${priLabel}），全做完即停`,
        mode: "priority-stop",
        stopMode: "serial",
        order: targets.slice(),
      });

      // 先算各優先可達最高，供方案說明與「衝高單軸」
      ensureMaxBurstCache(targets);
      const st = opts.startTotals || null;
      const peaks = Object.fromEntries(
        targets.map((a) => [
          a,
          theoreticalPeak(a, {
            start: (st && st[a]) || 0,
            budget: bg,
          }),
        ])
      );

      // ★ 每個優先屬性各一組：專攻到該軸可達最高（先做該軸再做其餘）
      for (const a of targets) {
        const peak = peaks[a];
        const rest = targets.filter((x) => x !== a);
        const order = [a, ...rest];
        const peakTxt =
          peak && peak.limit > 0
            ? `可達最高 ${peak.final}（超+${peak.over}）`
            : "無有效上限";
        push({
          id: `proven-peak-${a}`,
          name: `★ 最高${a}`,
          desc: `專攻${a}到單軸可達最高：${peakTxt}；其餘優先其後再做`,
          mode: "proven",
          order,
          peakAttr: a,
        });
      }

      // ★ 全優先依序都衝最高（可證明各軸決勝 = 全搜尋最大 4 件）
      push({
        id: "proven-max-burst",
        name: "★ 全優先最高（依序）",
        desc: `依優先序逐軸：堆到上限前一檔→決勝最大 4 件（${priLabel}）`,
        mode: "proven",
        order: targets.slice(),
      });

      if (targets.length >= 2 && targets.length <= 3) {
        for (const order of permutations(targets)) {
          if (order.join("-") === targets.join("-")) continue;
          // 與「最高X」開頭順序相同的略過
          if (
            order[0] &&
            order.slice(1).join("-") ===
              targets.filter((x) => x !== order[0]).join("-")
          ) {
            continue;
          }
          push({
            id: `proven-max-${order.join("-")}`,
            name: `★ 最高序 ${order.join("→")}`,
            desc: `各軸理論最高決勝，順序：${order.join(" → ")}`,
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
            name: `★ 嚴格 ${order.join("→")}`,
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
            name: `順序 ${order.join("→")}`,
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

      for (const a of enhanceableAttrs(totals)) {
        if (isAutoAllocTarget(a)) continue;
        score += (cap[a] || 0) * 0.001;
      }
      return { valid, score, cap };
    }

    function pickBestFourParts(totals, roundsLeft, strategy) {
      const all = getPartPool();
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
              // 後備非優先極弱加分
              for (const a of ATTRS) {
                // ponytail: fb 本身無放大倍率，tiebreak 需再低一階才不會反轉
                if (!isAutoAllocTarget(a)) fb += (cap[a] || 0) * 0.00001;
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
     * opts.startTotals / opts.maxNewRounds：接著配時從既有總值繼續。
     */
    function simulateAutoPlan(strategy, maxR, opts = {}) {
      if (strategy.mode === "proven") {
        const order =
          Array.isArray(strategy.order) && strategy.order.length
            ? strategy.order
            : userPriorityAttrs();
        return simulateProvenMaxBurst(order, maxR, strategy, opts);
      }
      if (strategy.mode === "priority-stop") {
        return simulatePriorityOvershootStop(strategy, maxR, opts);
      }
      if (strategy.mode === "priority-stop-min") {
        return simulateMinRoundsPriorityStop(strategy, maxR, opts);
      }

      const st = opts.startTotals || startTotals;
      const maxNew = opts.maxNewRounds != null ? opts.maxNewRounds : maxR;
      let totals = { ...st };
      const planRounds = [];

      for (let r = 0; r < maxNew; r++) {
        const roundsLeft = maxNew - r;
        const focus = strategyFocusAttrs(totals, strategy);
        // 僅優先可強化；全封則停（不硬用完次數）
        if (!focus.length) break;

        const chosen = pickBestFourParts(totals, roundsLeft, strategy);
        if (!chosen || chosen.length !== SLOTS) break;

        const round = emptyRound();
        round.parts = chosen.slice();
        const cap = roundPartCap(round);
        const delta = Object.fromEntries(ATTRS.map((a) => [a, 0]));

        for (const a of ATTRS) {
          delta[a] = canEnhanceAttr(totals[a] || 0, a) ? cap[a] || 0 : 0;
        }

        // 通過才寫回 totals（ponytail-fix，同 simulatePriorityOvershootStop 說明）：
        // round 被拒（本輪對目前優先焦點毫無增量）時不得留下副作用，否則回傳的 totals
        // 會多算一輪沒被記錄進 rounds 的幽靈增量，破壞「重放 rounds===plan.totals」的合法性
        if (!focus.some((a) => (delta[a] || 0) > 0)) break;

        for (const a of ATTRS) {
          totals[a] = (totals[a] || 0) + delta[a];
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

    // ===================== 主流程：跑全部策略 → 過濾不完整 → 內部去重 → 排序 =====================
    // （沿用舊版 buildAndShowAutoPlans 的迴圈邏輯；第二層「同結果不同卡合併」留給 app.js
    //   既有 sig2 去重與 exact 卡片一起處理，模組只做第一層。）

    const strategies = buildUserPriorityStrategies(budget, { startTotals });
    const rawPlans = [];
    const seen = new Set();
    let strategiesTried = 0;
    for (const strategy of strategies) {
      strategiesTried++;
      let plan;
      try {
        plan = simulateAutoPlan(strategy, budget, {
          startTotals,
          maxNewRounds: budget,
        });
      } catch (err) {
        continue; // 單一策略出錯不得拖垮整批
      }
      if (!plan || !plan.rounds.length) continue;
      if (plan.rounds.some((r) => !isPartsComplete(r))) continue;
      // 去重：同策略 id 保留；不同策略即使總值相同也保留（避免超限即停被吃掉）
      const sig =
        strategy.id +
        "|" +
        ATTRS.map((a) => plan.totals[a] || 0).join(",") +
        "|r" +
        plan.roundCount;
      if (seen.has(sig)) continue;
      seen.add(sig);
      rawPlans.push(plan);
    }

    // 固定把「超限即停」系列排在最前，方便找到
    const stopRank = (p) => {
      const m = p.strategy.mode;
      if (m === "priority-stop-min") return 0;
      if (m === "priority-stop") return 1;
      if (m === "proven") return 2;
      return 3;
    };
    rawPlans.sort((p, q) => {
      const rd = stopRank(p) - stopRank(q);
      if (rd !== 0) return rd;
      // 同系列：輪數少優先（省次數），再比超限合計
      if (p.roundCount !== q.roundCount && stopRank(p) <= 1) {
        return p.roundCount - q.roundCount;
      }
      const over = (plan) => {
        let s = 0;
        for (const a of userPriorityAttrs()) {
          const lim = getAttrLimit(a);
          const v = plan.totals[a] || 0;
          if (lim != null && v > lim) s += v - lim;
        }
        return s;
      };
      return over(q) - over(p);
    });

    const limited = rawPlans.slice(0, 30);
    const plans = limited.map((p) => ({
      id: p.strategy.id,
      name: p.strategy.name,
      desc: p.strategy.desc,
      legacyMode: p.strategy.mode,
      rounds: p.rounds.map((r) => r.parts.slice()),
      totals: { ...p.totals },
      roundCount: p.roundCount,
    }));

    return {
      plans,
      stats: { ms: Date.now() - t0, strategiesTried },
    };
  }

  // globalThis（非 window）：純函式模組不碰 DOM，須同時能在瀏覽器主執行緒與 Web Worker
  // （無 window，只有 self／globalThis）載入；Node 測試環境 globalThis 即 global，行為一致。
  globalThis.AutoAllocLegacy = { solve };
})();

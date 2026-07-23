/**
 * 大航海傳說 · 船隻強化模擬器 — 自動配精確求解器
 *
 * 純函式模組：同輸入必同輸出，不碰 DOM／window 以外任何全域。
 * 演算法：分層 BFS（依規劃輪數逐層展開）＋ 狀態去重（合法支配剪枝）＋ 束寬剪枝。
 *
 * 遊戲規則（求解器嚴格遵守）：
 * - 每輪選 4 個互不相同零件，該輪各屬性增量 = 4 件加成總和
 * - 屬性目前累計 < 上限 L → 本輪整輪加成吃滿（可一次衝超過 L）；累計 ≥ L → 封印，之後增量恆 0
 * - 封印判定逐輪結算：同一輪內不分先後，先算 4 件加總的 cap，再一次套用
 */
(() => {
  "use strict";

  // ===================== 字典序比較 =====================

  /** 逐項比大，前項相同才比後項；a>b 回正、a<b 回負 */
  function lexCompare(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  // ===================== 零件池與向量預計算 =====================

  /**
   * 窮舉零件池所有 4 件組合，投影到「全部優先屬性」去重（同鍵留非優先加總最大者），
   * 丟棄對所有優先屬性皆 0 的向量（一輪全無優先增益＝浪費輪，最優解不會用）。
   */
  function precomputeVectors(parts, priAttrs, nonPriAttrs, pureSail) {
    let pool = Object.values(parts);
    if (pureSail) pool = pool.filter((p) => !((p.bonus["槳力"] || 0) > 0));
    const n = pool.length;
    const k = priAttrs.length;
    const map = new Map();
    if (n < 4) return [];
    for (let i = 0; i < n - 3; i++) {
      for (let j = i + 1; j < n - 2; j++) {
        for (let x = j + 1; x < n - 1; x++) {
          for (let y = x + 1; y < n; y++) {
            const four = [pool[i], pool[j], pool[x], pool[y]];
            const vec = new Array(k);
            let allZero = true;
            for (let m = 0; m < k; m++) {
              const a = priAttrs[m];
              let sum = 0;
              for (const p of four) sum += p.bonus[a] || 0;
              vec[m] = sum;
              if (sum !== 0) allZero = false;
            }
            if (allZero) continue;
            let nonPriSum = 0;
            for (const a of nonPriAttrs) {
              for (const p of four) nonPriSum += p.bonus[a] || 0;
            }
            const key = vec.join(",");
            const existed = map.get(key);
            if (!existed || nonPriSum > existed.nonPriSum) {
              map.set(key, { vec, nonPriSum, partIds: four.map((p) => p.id) });
            }
          }
        }
      }
    }
    return Array.from(map.values());
    // 註：曾在此加過「向量層級」支配剪枝（A 每維皆 <= B 就丟棄 A），已移除——不安全。
    // 反例：L=40，目前 36；只用「+7」小向量要湊到 39 再用「+18」大向量決勝 → 57；
    // 若「+7」被「+18」（其餘維度相同或更好）支配丟棄，就湊不出 39，只能 36+18=54 封頂。
    // 小向量是「貼上限前一檔」stacking 路線的必要材料，向量層級的支配關係在多輪序列下不成立。
  }

  /**
   * 依 open-mask（＝目前狀態的 sealedMask）建向量投影去重子表快取：lazy 建表＋快取，
   * main／peaks 共用同一份（vectors／k 不變，只是分層不同，跟 mask 無關）。
   * 原理：狀態轉移效果只由「向量在 open 屬性上的投影＋nonPriSum」決定——封印越多，不同向量
   * 投影到剩餘 open 維度後碰撞越多（例：全 open 時 561 條，剩單一屬性 open 時可能只剩 ~35
   * 種 distinct 投影）。同投影只留 nonPriSum 最大者（跟 precomputeVectors 的去重語意一致）。
   * 這是「狀態層級」的安全去重（同 mask 下投影相同＝轉移效果必相同），不是被移除的向量支配剪枝
   * ——不會丟掉任何「貼上限前一檔」需要的小向量，只合併效果完全等價的重複項。
   * 子表項目保留原始 vi（vectors 中的索引），供 parent 追蹤沿用既有 idx*vectors.length+vi 編碼。
   */
  function makeOpenMaskCache(vectors, k) {
    const cache = new Map(); // sealedMask -> 去重後子表 [{ve, vi}, ...]
    return function getSubVectors(sealedMask) {
      let sub = cache.get(sealedMask);
      if (sub) return sub;
      const openDims = [];
      for (let i = 0; i < k; i++) if (!(sealedMask & (1 << i))) openDims.push(i);
      const map = new Map();
      for (let vi = 0; vi < vectors.length; vi++) {
        const ve = vectors[vi];
        let any = false;
        let key = "";
        for (let oi = 0; oi < openDims.length; oi++) {
          const v = ve.vec[openDims[oi]];
          if (v) any = true;
          key += v + ",";
        }
        if (!any) continue;
        const existed = map.get(key);
        if (!existed || ve.nonPriSum > existed.ve.nonPriSum) map.set(key, { ve, vi });
      }
      sub = Array.from(map.values());
      cache.set(sealedMask, sub);
      return sub;
    };
  }

  // ===================== 優先分層 =====================

  /** 依優先數字分層：數字最小的一群＝T1，次小＝T2……(保留 priAttrs 原順序) */
  function buildTiers(priAttrs, priorities) {
    const byVal = new Map();
    for (const a of priAttrs) {
      const v = priorities[a];
      if (!byVal.has(v)) byVal.set(v, []);
      byVal.get(v).push(a);
    }
    return Array.from(byVal.keys())
      .sort((x, y) => x - y)
      .map((v) => byVal.get(v));
  }

  /** 建立某次分層下的搜尋上下文（priAttrs 順序固定，只有 tiers 分組會變） */
  function makeCtx(priAttrs, tiers, limits) {
    const k = priAttrs.length;
    const limitsArr = priAttrs.map((a) => (limits[a] != null ? limits[a] : null));
    const sealable = limitsArr.map((l) => l != null);
    const tierOf = new Array(k).fill(-1);
    tiers.forEach((grp, t) => {
      for (const a of grp) {
        const i = priAttrs.indexOf(a);
        if (i >= 0) tierOf[i] = t;
      }
    });
    const tierCount = tiers.length;
    const tierSealableCount = new Array(tierCount).fill(0);
    for (let i = 0; i < k; i++) if (sealable[i]) tierSealableCount[tierOf[i]]++;
    return { priAttrs, k, limitsArr, sealable, tierOf, tierCount, tierSealableCount };
  }

  // ===================== 狀態機 =====================

  /** 起始狀態（depth 0）：startTotals 已 ≥ 上限、或上限＝0 者，一開始就封印 */
  function initState(ctx, startTotals) {
    const vals = ctx.priAttrs.map((a) => startTotals[a] || 0);
    let sealedMask = 0;
    const tierSealedCount = new Array(ctx.tierCount).fill(0);
    const tierFinalsSum = new Array(ctx.tierCount).fill(0);
    for (let i = 0; i < ctx.k; i++) {
      if (ctx.sealable[i] && vals[i] >= ctx.limitsArr[i]) {
        sealedMask |= 1 << i;
        tierSealedCount[ctx.tierOf[i]]++;
        tierFinalsSum[ctx.tierOf[i]] += vals[i];
      }
    }
    return { vals, sealedMask, tierSealedCount, tierFinalsSum, nonPriSum: 0, parent: null, partIds: null };
  }

  /**
   * 狀態＋一個預計算向量 → 下一狀態；對此狀態所有 open 優先屬性增量皆 0 則回 null（跳過）。
   * 先做一輪不配置陣列的試探（多數「跳過」發生在後段輪次、多數優先已封時），
   * 確定有效才真正 slice 配置新陣列 — 這是效能熱點，避免無謂配置。
   */
  function stepState(state, ve, ctx) {
    const k = ctx.k;
    const sm0 = state.sealedMask;
    let any = false;
    for (let i = 0; i < k; i++) {
      if (!(sm0 & (1 << i)) && ve.vec[i]) {
        any = true;
        break;
      }
    }
    if (!any) return null;

    const vals = state.vals.slice();
    let sealedMask = sm0;
    const tierSealedCount = state.tierSealedCount.slice();
    const tierFinalsSum = state.tierFinalsSum.slice();
    for (let i = 0; i < k; i++) {
      if (sealedMask & (1 << i)) continue; // 已封：增量恆 0
      const delta = ve.vec[i];
      if (!delta) continue;
      const nv = vals[i] + delta;
      vals[i] = nv;
      if (ctx.sealable[i] && nv >= ctx.limitsArr[i]) {
        sealedMask |= 1 << i;
        tierSealedCount[ctx.tierOf[i]]++;
        tierFinalsSum[ctx.tierOf[i]] += nv;
      }
    }
    return {
      vals,
      sealedMask,
      tierSealedCount,
      tierFinalsSum,
      nonPriSum: state.nonPriSum + ve.nonPriSum,
      parent: state,
      partIds: ve.partIds,
    };
  }

  const KEY_SLOT_BITS = 12;
  const KEY_SLOT_BASE = 1 << KEY_SLOT_BITS; // 4096；k<=4 時 sealedMask(<16)*BASE^4 仍遠低於 2^53 安全整數上界

  /**
   * 狀態鍵：各優先屬性的 (累計 或 "S" 已封) 序列；open 相同 → 未來可達完全相同。
   * 效能熱點：k<=4 且各 open 值 < 4096 時打包成一個數字（Map<number> 遠快於 Map<string>）；
   * 超出安全範圍（罕見：無上限屬性長輪數暴衝）才退回字串鍵，正確性不受影響。
   */
  function stateKeyOf(state, ctx) {
    if (ctx.k <= 4) {
      let num = state.sealedMask;
      let overflow = false;
      for (let i = 0; i < ctx.k; i++) {
        const v = state.sealedMask & (1 << i) ? 0 : state.vals[i];
        if (v >= KEY_SLOT_BASE) {
          overflow = true;
          break;
        }
        num = num * KEY_SLOT_BASE + v;
      }
      if (!overflow) return num;
    }
    let s = "s";
    for (let i = 0; i < ctx.k; i++) {
      s += state.sealedMask & (1 << i) ? "S," : state.vals[i] + ",";
    }
    return s;
  }

  /** 已封分量（各層封數／finals 和 + 非優先累加）：同狀態鍵去重時的合法支配比較用（除錯／低頻用途，配置陣列） */
  function accumArr(state) {
    const out = [];
    for (let t = 0; t < state.tierSealedCount.length; t++) {
      out.push(state.tierSealedCount[t], state.tierFinalsSum[t]);
    }
    out.push(state.nonPriSum);
    return out;
  }

  /** accumArr 的直接比較版（熱路徑：合併同鍵狀態時用，不配置陣列） */
  function compareAccum(a, b) {
    const tc = a.tierSealedCount.length;
    for (let t = 0; t < tc; t++) {
      let d = a.tierSealedCount[t] - b.tierSealedCount[t];
      if (d !== 0) return d;
      d = a.tierFinalsSum[t] - b.tierFinalsSum[t];
      if (d !== 0) return d;
    }
    return a.nonPriSum - b.nonPriSum;
  }

  /** completeKey 的直接比較版（熱路徑：每層排序／挑最佳用，不配置陣列） */
  function compareComplete(a, b, ctx) {
    for (let t = 0; t < ctx.tierCount; t++) {
      let d = a.tierSealedCount[t] - b.tierSealedCount[t];
      if (d !== 0) return d;
      let openA = 0;
      let openB = 0;
      for (let i = 0; i < ctx.k; i++) {
        if (ctx.tierOf[i] !== t) continue;
        if (!(a.sealedMask & (1 << i))) openA += a.vals[i];
        if (!(b.sealedMask & (1 << i))) openB += b.vals[i];
      }
      d = a.tierFinalsSum[t] + openA - (b.tierFinalsSum[t] + openB);
      if (d !== 0) return d;
    }
    return a.nonPriSum - b.nonPriSum;
  }

  /** 完整字典序鍵：accum + 「若在此停手」時仍 open 的屬性當下值併入各層 finals 和 */
  function completeKey(state, ctx) {
    const out = [];
    for (let t = 0; t < ctx.tierCount; t++) {
      let openSum = 0;
      for (let i = 0; i < ctx.k; i++) {
        if (ctx.tierOf[i] === t && !(state.sealedMask & (1 << i))) openSum += state.vals[i];
      }
      out.push(state.tierSealedCount[t], state.tierFinalsSum[t] + openSum);
    }
    out.push(state.nonPriSum);
    return out;
  }

  /** 全部（有上限的）優先屬性是否皆已封 — 無上限者不參與判定 */
  function isFullySealed(state, ctx) {
    for (let t = 0; t < ctx.tierCount; t++) {
      if (state.tierSealedCount[t] !== ctx.tierSealableCount[t]) return false;
    }
    return true;
  }

  /**
   * 分層 BFS 主體（通用陣列版，k>4 或數值可能超出打包安全範圍時的後備）：逐輪展開、同鍵僅留
   * accum 較大者、每層超過 beamWidth 依完整鍵排序剪枝。回傳每層「若在此停手」最佳狀態
   * （bestAtDepth）與首次全封層（minRoundsDepth，僅主層需要）。
   */
  function runBFSGeneric(vectors, ctx, budget, startTotals, beamWidth, wantMinRounds) {
    const s0 = initState(ctx, startTotals);
    const bestAtDepth = [s0];
    let statesExplored = 1;
    let firstTruncatedDepth = Infinity;
    let minRoundsDepth = null;
    let minRoundsState = null;
    if (wantMinRounds && isFullySealed(s0, ctx)) {
      minRoundsDepth = 0;
      minRoundsState = s0;
    }

    let layer = [s0];
    for (let depth = 1; depth <= budget && layer.length; depth++) {
      const next = new Map();
      for (const st of layer) {
        for (const ve of vectors) {
          const child = stepState(st, ve, ctx);
          if (!child) continue;
          statesExplored++;
          const key = stateKeyOf(child, ctx);
          const existed = next.get(key);
          if (!existed || compareAccum(child, existed) > 0) {
            next.set(key, child);
          }
        }
      }
      if (typeof process !== "undefined" && process.env && process.env.AUTOALLOC_DEBUG) {
        console.error(`[dbg] depth=${depth} layer.length(in)=${layer.length} next.size=${next.size}`);
      }
      let arr = Array.from(next.values());
      if (!arr.length) {
        layer = [];
        break;
      }
      // 剪枝依 accum 排序（規格明定，非完整鍵）：只看「已封」貢獻，
      // 不讓仍 open、尚未封頂的高潛力狀態因「還沒封」而被完整鍵誤判劣勢提早淘汰。
      arr.sort((a, b) => -compareAccum(a, b));
      if (arr.length > beamWidth) {
        // 補強：accum 對「尚未封」的屬性一律記 0——單一屬性成一層時（如 peaks 的 X 自成
        // T1）完全無法從 accum 分辨進度，會讓「先蓄力、最後一擊衝更高」的路線被提早剪光。
        // 保留各仍 open 可封屬性目前累計最高的狀態，確保這類路線至少能延續到下一層。
        const champions = [];
        for (let i = 0; i < ctx.k; i++) {
          if (!ctx.sealable[i]) continue;
          let champ = null;
          for (const s of arr) {
            if (s.sealedMask & (1 << i)) continue;
            if (!champ || s.vals[i] > champ.vals[i]) champ = s;
          }
          if (champ) champions.push(champ);
        }
        const kept = arr.slice(0, beamWidth);
        const keptSet = new Set(kept);
        for (const c of champions) {
          if (!keptSet.has(c)) {
            kept.push(c);
            keptSet.add(c);
          }
        }
        arr = kept;
        if (depth < firstTruncatedDepth) firstTruncatedDepth = depth;
      }
      layer = arr;
      // 「若在此停手」的最佳狀態改依完整鍵，在存活者中另外找（跟剪枝排序是兩件事）
      let best = arr[0];
      for (let i = 1; i < arr.length; i++) {
        if (compareComplete(arr[i], best, ctx) > 0) best = arr[i];
      }
      bestAtDepth[depth] = best;
      if (wantMinRounds && minRoundsDepth == null) {
        const found = arr.find((s) => isFullySealed(s, ctx));
        if (found) {
          minRoundsDepth = depth;
          minRoundsState = found;
        }
      }
    }
    return { bestAtDepth, minRoundsDepth, minRoundsState, statesExplored, firstTruncatedDepth };
  }

  /**
   * runBFSFast 資格判定：k<=4（沿用 stateKeyOf 既有數字打包門檻）且每個優先屬性在 budget 輪內
   * 可能達到的最大值都 < KEY_SLOT_BASE（可封屬性：limit+單輪最大加成；不可封屬性：單輪最大加成
   * ×budget，因為永不封、可能累到很大）。任何一項超出就退回通用陣列版，正確性優先。
   */
  function beamFastEligible(ctx, vectors, budget) {
    if (ctx.k > 4) return false;
    for (let i = 0; i < ctx.k; i++) {
      let maxBurst = 0;
      for (const ve of vectors) if (ve.vec[i] > maxBurst) maxBurst = ve.vec[i];
      const bound = ctx.sealable[i] ? ctx.limitsArr[i] + maxBurst : maxBurst * budget;
      if (bound >= KEY_SLOT_BASE) return false;
    }
    return true;
  }

  /** keyPacked（stateKeyOf 數字版打包公式）反解回 {sealedMask, vals}（vals 對 sealed 維度為 0，不會被讀） */
  function decodeKeyPacked(numKey, k) {
    const vals = new Array(k);
    let rem = numKey;
    for (let i = k - 1; i >= 0; i--) {
      vals[i] = rem % KEY_SLOT_BASE;
      rem = Math.floor(rem / KEY_SLOT_BASE);
    }
    return { sealedMask: rem, vals };
  }

  /** 零配置打包狀態 → 跟陣列版相容的完整物件（completeKey／isFullySealed／reconstructRounds 共用） */
  function materializePackedBeamState(st, ctx, layout) {
    const { sealedMask, vals } = decodeKeyPacked(st.keyPacked, ctx.k);
    const { tierSealedCount, tierFinalsSum, nonPriSum } = unpackAccum(layout, st.accumPacked, ctx.tierCount);
    return { vals, sealedMask, tierSealedCount, tierFinalsSum, nonPriSum, parent: st.parent, partIds: st.partIds };
  }

  /**
   * runBFS 的零配置快路徑（k<=4、數值在安全範圍內）：狀態＝{keyPacked,accumPacked,parent,partIds}，
   * 無 vals/tierSealedCount/tierFinalsSum 子陣列。keyPacked 沿用 stateKeyOf 的數字打包公式當
   * Map key；accumPacked 沿用密集模式的 packAccum，兩者轉移都用「對打包數字加差量」，不解包/
   * 重包、不配置中間陣列（跟 runDense 同一套紀律）。邏輯（merge/剪枝/champion/bestAtDepth/
   * minRounds）跟 runBFSGeneric 逐項對應，只是換零配置的資料結構。
   */
  function runBFSFast(vectors, ctx, budget, startTotals, beamWidth, wantMinRounds, getSubVectors, onProgress, providedLayout) {
    const k = ctx.k;
    const layout = providedLayout || computeAccumLayout(ctx, vectors, budget);
    const weight = new Array(k); // 位權 BASE^(k-1-i)
    let w = 1;
    for (let i = k - 1; i >= 0; i--) {
      weight[i] = w;
      w *= KEY_SLOT_BASE;
    }
    const SEALMASK_WEIGHT = w; // BASE^k

    let sealedMask0 = 0;
    const vals0 = new Array(k);
    const tierSealedCount0 = new Array(ctx.tierCount).fill(0);
    const tierFinalsSum0 = new Array(ctx.tierCount).fill(0);
    for (let i = 0; i < k; i++) {
      const v = startTotals[ctx.priAttrs[i]] || 0;
      vals0[i] = v;
      if (ctx.sealable[i] && v >= ctx.limitsArr[i]) {
        sealedMask0 |= 1 << i;
        tierSealedCount0[ctx.tierOf[i]]++;
        tierFinalsSum0[ctx.tierOf[i]] += v;
      }
    }
    let keyPacked0 = sealedMask0 * SEALMASK_WEIGHT;
    for (let i = 0; i < k; i++) {
      if (!(sealedMask0 & (1 << i))) keyPacked0 += vals0[i] * weight[i];
    }
    const accumPacked0 = packAccum(layout, tierSealedCount0, tierFinalsSum0, 0);

    const s0Full = {
      vals: vals0,
      sealedMask: sealedMask0,
      tierSealedCount: tierSealedCount0,
      tierFinalsSum: tierFinalsSum0,
      nonPriSum: 0,
      parent: null,
      partIds: null,
    };
    const bestAtDepth = [s0Full];
    let statesExplored = 1;
    let firstTruncatedDepth = Infinity;
    let minRoundsDepth = null;
    let minRoundsState = null;
    if (wantMinRounds && isFullySealed(s0Full, ctx)) {
      minRoundsDepth = 0;
      minRoundsState = s0Full;
    }

    let layer = [{ keyPacked: keyPacked0, accumPacked: accumPacked0, parent: null, partIds: null }];

    for (let depth = 1; depth <= budget && layer.length; depth++) {
      const next = new Map();
      for (const st of layer) {
        // 解出目前 vals／sealedMask／openDims，每個 state 只解一次（不必每個 vector 重算）
        let rem = st.keyPacked;
        const vals = new Array(k);
        for (let i = k - 1; i >= 0; i--) {
          vals[i] = rem % KEY_SLOT_BASE;
          rem = Math.floor(rem / KEY_SLOT_BASE);
        }
        const sealedMask = rem;
        const openDims = [];
        for (let i = 0; i < k; i++) if (!(sealedMask & (1 << i))) openDims.push(i);
        const nOpen = openDims.length;
        if (nOpen === 0) continue;

        // subVectors 已依此 sealedMask 去重過投影，保證每條對某個 open 維度有貢獻，免 any 判斷。
        const subVectors = getSubVectors(sealedMask);
        for (let si = 0; si < subVectors.length; si++) {
          const ve = subVectors[si].ve;
          let keyDelta = 0;
          let packedDelta = ve.nonPriSum * layout.nonPriPow;
          for (let oi = 0; oi < nOpen; oi++) {
            const i = openDims[oi];
            const delta = ve.vec[i];
            if (!delta) continue;
            const nv = vals[i] + delta;
            if (ctx.sealable[i] && nv >= ctx.limitsArr[i]) {
              keyDelta += (1 << i) * SEALMASK_WEIGHT - vals[i] * weight[i];
              const t = ctx.tierOf[i];
              packedDelta += layout.tierCountPow[t] + nv * layout.tierSumPow[t];
            } else {
              keyDelta += delta * weight[i];
            }
          }
          statesExplored++;
          const nextKey = st.keyPacked + keyDelta;
          const nextAccum = st.accumPacked + packedDelta;
          const existed = next.get(nextKey);
          if (!existed || nextAccum > existed.accumPacked) {
            next.set(nextKey, { keyPacked: nextKey, accumPacked: nextAccum, parent: st, partIds: ve.partIds });
          }
        }
      }

      if (onProgress) onProgress(depth);
      let arr = Array.from(next.values());
      if (!arr.length) {
        layer = [];
        break;
      }
      // 剪枝依 accum 排序：打包數字直接比大小＝逐項字典序比較，免 compareAccum 陣列走訪
      arr.sort((a, b) => b.accumPacked - a.accumPacked);
      if (arr.length > beamWidth) {
        // champion 補強（同 runBFSGeneric 語意）：低頻操作（只在剪枝發生時對這層候選做一次），
        // 每個候選只解一次 vals 供全部 k 個 champion 查找共用，不逐一重複解碼。
        const decoded = arr.map((s) => decodeKeyPacked(s.keyPacked, k));
        const champions = [];
        for (let i = 0; i < k; i++) {
          if (!ctx.sealable[i]) continue;
          let champIdx = -1;
          let champVal = -1;
          for (let m = 0; m < arr.length; m++) {
            if (decoded[m].sealedMask & (1 << i)) continue;
            if (decoded[m].vals[i] > champVal) {
              champVal = decoded[m].vals[i];
              champIdx = m;
            }
          }
          if (champIdx >= 0) champions.push(arr[champIdx]);
        }
        const kept = arr.slice(0, beamWidth);
        const keptSet = new Set(kept);
        for (const c of champions) {
          if (!keptSet.has(c)) {
            kept.push(c);
            keptSet.add(c);
          }
        }
        arr = kept;
        if (depth < firstTruncatedDepth) firstTruncatedDepth = depth;
      }
      layer = arr;

      let bestFull = materializePackedBeamState(arr[0], ctx, layout);
      for (let i = 1; i < arr.length; i++) {
        const cand = materializePackedBeamState(arr[i], ctx, layout);
        if (compareComplete(cand, bestFull, ctx) > 0) bestFull = cand;
      }
      bestAtDepth[depth] = bestFull;

      if (wantMinRounds && minRoundsDepth == null) {
        for (const s of arr) {
          const full = materializePackedBeamState(s, ctx, layout);
          if (isFullySealed(full, ctx)) {
            minRoundsDepth = depth;
            minRoundsState = full;
            break;
          }
        }
      }
    }

    return { bestAtDepth, minRoundsDepth, minRoundsState, statesExplored, firstTruncatedDepth };
  }

  /**
   * runBFS 分流：k<=4 且數值範圍安全 → 零配置快路徑（getSubVectors 依 open-mask 去重子表）；
   * 否則通用陣列版（正確性優先的後備，未套用子表去重）。
   */
  function runBFS(vectors, ctx, budget, startTotals, beamWidth, wantMinRounds, getSubVectors, onProgress) {
    if (beamFastEligible(ctx, vectors, budget)) {
      // accum 打包位元和必須落在 Float64 安全整數內，否則數字比較失真 → 退通用陣列版
      const layout = computeAccumLayout(ctx, vectors, budget);
      if (layout.totalBits <= 52) {
        return runBFSFast(vectors, ctx, budget, startTotals, beamWidth, wantMinRounds, getSubVectors, onProgress, layout);
      }
    }
    return runBFSGeneric(vectors, ctx, budget, startTotals, beamWidth, wantMinRounds);
  }

  // ===================== 密集精確模式（k 小、packedSize 小時取代 beam） =====================
  //
  // 束寬剪枝終究是近似：一般情況（k 大、狀態空間大）沒辦法，但 k 小時狀態空間本身就小，
  // 可以把每個優先屬性的「目前累計或已封」編成單一整數 idx，直接用 TypedArray 當雜湊表
  // （O(1) 索引取代 Map 雜湊，且零物件配置、零字串鍵），窮舉不剪枝 → provable 恆為 true。

  function gcdTwo(a, b) {
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  /**
   * 每個優先屬性、所有向量非零增量的最大公因數：因為每輪加成 = 4 件加總，可達累計恆是
   * g_i 的倍數（起點若也是倍數）。從未被任何向量觸及的維度回 1（無縮放收益，不影響正確性）。
   */
  function computeGcdPerAttr(vectors, k) {
    const g = new Array(k).fill(0);
    for (const ve of vectors) {
      for (let i = 0; i < k; i++) {
        const v = ve.vec[i];
        if (v) g[i] = g[i] ? gcdTwo(g[i], v) : v;
      }
    }
    for (let i = 0; i < k; i++) if (!g[i]) g[i] = 1;
    return g;
  }

  /**
   * GCD 軸縮放資格判定：g_i=該屬性所有向量增量的最大公因數；起點非 g_i 倍數（接著配／手動
   * 輪次）時該屬性強制 g_i=1（保正確，不硬套）。縮放後 Lscaled_i=ceil(limit_i/g_i)，
   * packedSize=Π(Lscaled_i+2)：0..Lscaled_i-1 各開放值＋SEALED 哨兵，留 1 格安全餘裕。
   * 任何優先屬性上限為 null（無上限）就無法密集編碼；packedSize 超過門檻回 null（改用 beam）。
   */
  function denseEligibility(priAttrs, limits, vectors, startTotals, threshold) {
    const k = priAttrs.length;
    for (const a of priAttrs) if (limits[a] == null) return null;
    const gArr = computeGcdPerAttr(vectors, k);
    for (let i = 0; i < k; i++) {
      const start = startTotals[priAttrs[i]] || 0;
      if (gArr[i] > 1 && start % gArr[i] !== 0) gArr[i] = 1;
    }
    const LscaledArr = new Array(k);
    let packedSize = 1;
    for (let i = 0; i < k; i++) {
      LscaledArr[i] = Math.ceil(limits[priAttrs[i]] / gArr[i]);
      packedSize *= LscaledArr[i] + 2;
      if (packedSize > threshold) return null;
    }
    return { packedSize, gArr, LscaledArr };
  }

  /** 混基數編碼（縮放後）：base_i=Lscaled_i+1（digit 0..Lscaled_i-1 為開放值，===Lscaled_i 為 SEALED） */
  function buildDenseIndex(k, LscaledArr) {
    const base = new Array(k);
    const stride = new Array(k);
    let total = 1;
    for (let i = 0; i < k; i++) {
      base[i] = LscaledArr[i] + 1;
      stride[i] = total;
      total *= base[i];
    }
    return { base, stride, total };
  }

  /** decodeDigits 只需 idx/stride/base/k；沿用同一支給密集模式各處解碼用 */
  function decodeDigits(idx, stride, base, k) {
    const digits = new Array(k);
    for (let i = k - 1; i >= 0; i--) {
      digits[i] = Math.floor(idx / stride[i]) % base[i];
    }
    return digits;
  }

  /**
   * 動態計算 accum 打包位元配置：由高位到低位依序 [T1封數,T1和,T2封數,T2和,...,nonPriSum]，
   * 每個分量的位寬依實際可能上界計算（非寫死 3/12bit），確保 totalBits<=52（Float64 安全整數內）。
   * 高位在前 → 直接以數字大小比較就等於逐項字典序比較（不需拆開比對）。
   */
  function computeAccumLayout(ctx, vectors, budget) {
    const tierMaxSum = new Array(ctx.tierCount).fill(0);
    for (let i = 0; i < ctx.k; i++) {
      if (!ctx.sealable[i]) continue;
      let maxBurst = 0;
      for (const ve of vectors) if (ve.vec[i] > maxBurst) maxBurst = ve.vec[i];
      tierMaxSum[ctx.tierOf[i]] += ctx.limitsArr[i] + maxBurst; // 封印當下值 < limit+單輪最大加成，安全上界
    }
    let maxNonPriPerRound = 0;
    for (const ve of vectors) if (ve.nonPriSum > maxNonPriPerRound) maxNonPriPerRound = ve.nonPriSum;
    const maxNonPriSum = maxNonPriPerRound * budget;

    const bits = [];
    for (let t = 0; t < ctx.tierCount; t++) {
      bits.push(Math.max(1, Math.ceil(Math.log2(ctx.tierSealableCount[t] + 1))));
      bits.push(Math.max(1, Math.ceil(Math.log2(tierMaxSum[t] + 2))));
    }
    bits.push(Math.max(1, Math.ceil(Math.log2(maxNonPriSum + 2))));

    const shifts = new Array(bits.length);
    let shift = 0;
    for (let i = bits.length - 1; i >= 0; i--) {
      shifts[i] = shift;
      shift += bits[i];
    }
    const pow = shifts.map((s) => Math.pow(2, s));
    const mod = bits.map((b) => Math.pow(2, b));
    // 每層的 [封數位權, 和位權] + nonPriSum 位權：供熱路徑直接算「打包後差量」用，免中間陣列
    const tierCountPow = new Array(ctx.tierCount);
    const tierSumPow = new Array(ctx.tierCount);
    for (let t = 0; t < ctx.tierCount; t++) {
      tierCountPow[t] = pow[t * 2];
      tierSumPow[t] = pow[t * 2 + 1];
    }
    const nonPriPow = pow[pow.length - 1];
    return { bits, shifts, pow, mod, totalBits: shift, tierCountPow, tierSumPow, nonPriPow };
  }

  function packAccum(layout, tierSealedCount, tierFinalsSum, nonPriSum) {
    let n = 0;
    let fi = 0;
    for (let t = 0; t < tierSealedCount.length; t++) {
      n += tierSealedCount[t] * layout.pow[fi];
      fi++;
      n += tierFinalsSum[t] * layout.pow[fi];
      fi++;
    }
    n += nonPriSum * layout.pow[fi];
    return n;
  }

  function unpackAccum(layout, packed, tierCount) {
    const tierSealedCount = new Array(tierCount);
    const tierFinalsSum = new Array(tierCount);
    let fi = 0;
    for (let t = 0; t < tierCount; t++) {
      tierSealedCount[t] = Math.floor(packed / layout.pow[fi]) % layout.mod[fi];
      fi++;
      tierFinalsSum[t] = Math.floor(packed / layout.pow[fi]) % layout.mod[fi];
      fi++;
    }
    const nonPriSum = Math.floor(packed / layout.pow[fi]) % layout.mod[fi];
    return { tierSealedCount, tierFinalsSum, nonPriSum };
  }

  /**
   * idx + 打包 accum → 跟 beam 模式相容的 state 物件（completeKey／isFullySealed 可直接共用）。
   * digits 是 GCD 縮放後的值，vals 還原成真值（completeKey 的 open-fold-in 需要真值）。
   */
  function materializeDenseState(idx, packed, ctx, denseIdx, layout, depth) {
    const digits = decodeDigits(idx, denseIdx.stride, denseIdx.base, ctx.k);
    let sealedMask = 0;
    const vals = new Array(ctx.k);
    for (let i = 0; i < ctx.k; i++) {
      if (digits[i] === denseIdx.LscaledArr[i]) sealedMask |= 1 << i;
      vals[i] = digits[i] * denseIdx.gArr[i]; // 還原真值
    }
    const { tierSealedCount, tierFinalsSum, nonPriSum } = unpackAccum(layout, packed, ctx.tierCount);
    return {
      vals,
      sealedMask,
      tierSealedCount,
      tierFinalsSum,
      nonPriSum,
      _dense: true,
      _depth: depth,
      _idx: idx,
    };
  }

  /**
   * 密集精確 DP：狀態＝單一整數 idx，accum 打包成單一可比較數字存 Float64Array（O(1) 存取，
   * 不必雜湊、不必配置陣列/物件）。逐層只走訪「上一層實際出現過」的 idx 列表（不掃整個
   * TypedArray），跟 beam 模式一樣依實際可達狀態數成長，但沒有剪枝、沒有配置成本。
   * parent 用分層 Map（idx -> [prevIdx, vecIdx]）只存非空項，避免 TypedArray×budget 記憶體爆量。
   * getSubVectors(sealedMask)：依 open-mask 去重後的向量子表（見 makeOpenMaskCache），
   * 封印越多子表越小，直擊轉移數本身（先前只「篩相關」不去重的版本實測反而更慢，已改正）。
   */
  function runDense(vectors, ctx, budget, startTotals, wantMinRounds, denseIdx, layout, getSubVectors, onProgress) {
    const { base, stride, total, gArr, LscaledArr } = denseIdx;
    const k = ctx.k;

    const digits0 = new Array(k); // GCD 縮放後的值，用於 idx 編碼
    const vals0 = new Array(k); // 真值，state.vals 用（completeKey 的 open-fold-in 需要）
    let sealedMask0 = 0;
    const tierSealedCount0 = new Array(ctx.tierCount).fill(0);
    const tierFinalsSum0 = new Array(ctx.tierCount).fill(0);
    for (let i = 0; i < k; i++) {
      const v = startTotals[ctx.priAttrs[i]] || 0;
      vals0[i] = v;
      if (ctx.sealable[i] && v >= ctx.limitsArr[i]) {
        digits0[i] = LscaledArr[i];
        sealedMask0 |= 1 << i;
        tierSealedCount0[ctx.tierOf[i]]++;
        tierFinalsSum0[ctx.tierOf[i]] += v;
      } else {
        digits0[i] = Math.floor(v / gArr[i]); // v 保證是 gArr[i] 倍數（見 denseEligibility）
      }
    }
    let idx0 = 0;
    for (let i = 0; i < k; i++) idx0 += digits0[i] * stride[i];
    const packed0 = packAccum(layout, tierSealedCount0, tierFinalsSum0, 0);

    const s0 = {
      vals: vals0,
      sealedMask: sealedMask0,
      tierSealedCount: tierSealedCount0,
      tierFinalsSum: tierFinalsSum0,
      nonPriSum: 0,
      _dense: true,
      _depth: 0,
      _idx: idx0,
    };
    const bestAtDepth = [s0];
    let statesExplored = 1;
    let minRoundsDepth = null;
    let minRoundsState = null;
    if (wantMinRounds && isFullySealed(s0, ctx)) {
      minRoundsDepth = 0;
      minRoundsState = s0;
    }

    let accumCur = new Float64Array(total).fill(-1);
    accumCur[idx0] = packed0;
    let activeCur = [idx0];
    const parentLayers = [];
    // parent 記憶體：dense（2 個 Int32Array(total)／層，O(1) 存取免雜湊）優先；
    // 總量（× budget 層）超過門檻才退回分層 Map（只存非空，見 reconstructRoundsDense）。
    const PARENT_MEM_LIMIT = 150 * 1024 * 1024;
    const useDenseParent = total * budget * 8 <= PARENT_MEM_LIMIT;

    for (let depth = 1; depth <= budget && activeCur.length; depth++) {
      const accumNext = new Float64Array(total).fill(-1);
      let parentArr = null;
      let vecArr = null;
      let parentMap = null;
      if (useDenseParent) {
        parentArr = new Int32Array(total).fill(-1);
        vecArr = new Int32Array(total).fill(-1);
      } else {
        parentMap = new Map();
      }
      const activeNext = [];

      for (const idx of activeCur) {
        const packed = accumCur[idx];
        const digits = decodeDigits(idx, stride, base, k); // 縮放後的值
        // 已封維度對 nextIdx 的固定貢獻(idxBase)、開放維度清單／遮罩，每個 idx 只算一次
        let idxBase = 0;
        let sealedMask = 0;
        const openDims = [];
        for (let i = 0; i < k; i++) {
          if (digits[i] === LscaledArr[i]) {
            idxBase += digits[i] * stride[i];
            sealedMask |= 1 << i;
          } else {
            openDims.push(i);
          }
        }
        const nOpen = openDims.length;
        if (nOpen === 0) continue; // 全部維度已封：任何向量都不可能有效，整層向量迴圈可跳過

        // 熱路徑：打包是位權線性組合，直接對 packed 加「差量」，不必解包/重包整個 accum、
        // 不必配置 newDigits/newTierSealedCount/newTierFinalsSum 中間陣列（零物件配置）。
        // subVectors 已依此 sealedMask 去重過投影，保證每條對某個 open 維度有貢獻，免 any 判斷。
        // ve.vec[i] 是真值增量，除以 gArr[i]（保證整除）得縮放後差量；封印時再乘回 gArr[i] 存真值。
        const subVectors = getSubVectors(sealedMask);
        for (let si = 0; si < subVectors.length; si++) {
          const ve = subVectors[si].ve;
          const vi = subVectors[si].vi;
          let nextIdx = idxBase;
          let packedDelta = ve.nonPriSum * layout.nonPriPow;
          for (let oi = 0; oi < nOpen; oi++) {
            const i = openDims[oi];
            const delta = ve.vec[i];
            if (!delta) {
              nextIdx += digits[i] * stride[i];
              continue;
            }
            const nv = digits[i] + delta / gArr[i];
            if (nv >= LscaledArr[i]) {
              nextIdx += LscaledArr[i] * stride[i];
              const t = ctx.tierOf[i];
              const trueNV = nv * gArr[i];
              packedDelta += layout.tierCountPow[t] + trueNV * layout.tierSumPow[t];
            } else {
              nextIdx += nv * stride[i];
            }
          }
          statesExplored++;
          const newPacked = packed + packedDelta;
          const existed = accumNext[nextIdx];
          if (existed === -1) {
            accumNext[nextIdx] = newPacked;
            if (useDenseParent) {
              parentArr[nextIdx] = idx;
              vecArr[nextIdx] = vi;
            } else {
              parentMap.set(nextIdx, idx * vectors.length + vi);
            }
            activeNext.push(nextIdx);
          } else if (newPacked > existed) {
            accumNext[nextIdx] = newPacked;
            if (useDenseParent) {
              parentArr[nextIdx] = idx;
              vecArr[nextIdx] = vi;
            } else {
              parentMap.set(nextIdx, idx * vectors.length + vi);
            }
          }
        }
      }

      if (onProgress) onProgress(depth);
      if (!activeNext.length) break;
      parentLayers.push(useDenseParent ? { dense: true, parentArr, vecArr } : { dense: false, map: parentMap });
      accumCur = accumNext;
      activeCur = activeNext;

      let bestState = materializeDenseState(activeNext[0], accumCur[activeNext[0]], ctx, denseIdx, layout, depth);
      for (let m = 1; m < activeNext.length; m++) {
        const idx = activeNext[m];
        const cand = materializeDenseState(idx, accumCur[idx], ctx, denseIdx, layout, depth);
        if (compareComplete(cand, bestState, ctx) > 0) bestState = cand;
      }
      bestAtDepth[depth] = bestState;

      if (wantMinRounds && minRoundsDepth == null) {
        for (const idx of activeNext) {
          const st = materializeDenseState(idx, accumCur[idx], ctx, denseIdx, layout, depth);
          if (isFullySealed(st, ctx)) {
            minRoundsDepth = depth;
            minRoundsState = st;
            break;
          }
        }
      }
    }

    return {
      bestAtDepth,
      minRoundsDepth,
      minRoundsState,
      statesExplored,
      firstTruncatedDepth: Infinity, // 密集模式窮舉不剪枝，恆可證最優
      dense: true,
      parentLayers,
      vectors,
    };
  }

  // ===================== 方案重建與重放 =====================

  /** 沿父指標回溯 partIds 序列（由舊到新）— beam 模式（狀態物件鏈） */
  function reconstructRounds(state) {
    const seq = [];
    let s = state;
    while (s && s.parent) {
      seq.push(s.partIds);
      s = s.parent;
    }
    seq.reverse();
    return seq;
  }

  /**
   * 沿 parentLayers 回溯 partIds 序列（由舊到新）— 密集模式。每層可能是 dense（兩個
   * Int32Array(total)，O(1) 存取）或 sparse（Map，只存非空項，值＝idx*vectors.length+vi
   * 打包後的單一數字，熱路徑寫入時免配置 [idx,vi] 陣列），依 runDense 當時的記憶體判斷決定。
   */
  function reconstructRoundsDense(depth, idx, parentLayers, vectors) {
    const seq = [];
    let curIdx = idx;
    const vlen = vectors.length;
    for (let d = depth; d >= 1; d--) {
      const layer = parentLayers[d - 1];
      let prevIdx;
      let vi;
      if (layer.dense) {
        prevIdx = layer.parentArr[curIdx];
        vi = layer.vecArr[curIdx];
      } else {
        const entry = layer.map.get(curIdx);
        vi = entry % vlen;
        prevIdx = Math.floor(entry / vlen);
      }
      seq.push(vectors[vi].partIds);
      curIdx = prevIdx;
    }
    seq.reverse();
    return seq;
  }

  /** 用真實遊戲規則重放整個方案（所有屬性，含非優先），回傳最終累計 — 顯示值一律以此為準 */
  function replay(parts, attrs, limits, startTotals, roundsPartIds) {
    const totals = {};
    for (const a of attrs) totals[a] = startTotals[a] || 0;
    for (const ids of roundsPartIds) {
      const cap = {};
      for (const a of attrs) cap[a] = 0;
      for (const id of ids) {
        const p = parts[String(id)];
        if (!p) continue;
        for (const a of attrs) cap[a] += p.bonus[a] || 0;
      }
      for (const a of attrs) {
        const lim = limits[a];
        if (lim == null || totals[a] < lim) totals[a] += cap[a];
      }
    }
    return totals;
  }

  /** denseInfo 非空（{parentLayers, vectors}）時走密集模式回溯，否則走 beam 狀態鏈 */
  function buildPlan(state, ctx, parts, attrs, limits, startTotals, denseInfo) {
    const roundsPartIds =
      state._dense && denseInfo
        ? reconstructRoundsDense(state._depth, state._idx, denseInfo.parentLayers, denseInfo.vectors)
        : reconstructRounds(state);
    const totals = replay(parts, attrs, limits, startTotals, roundsPartIds);
    let sealedCount = 0;
    for (let i = 0; i < ctx.k; i++) {
      if (ctx.sealable[i] && (totals[ctx.priAttrs[i]] || 0) >= ctx.limitsArr[i]) sealedCount++;
    }
    return {
      rounds: roundsPartIds,
      totals,
      sealedCount,
      roundCount: roundsPartIds.length,
      key: completeKey(state, ctx),
    };
  }

  // ===================== 折衷點取樣 =====================

  /** minRounds 層與 lex 層之間、完整鍵與兩端皆不同的層，最多取 3 個（均勻分布） */
  function pickTradeoffs(bestAtDepth, dMin, dLex, ctx) {
    if (dMin == null || dMin === dLex) return [];
    const lo = Math.min(dMin, dLex);
    const hi = Math.max(dMin, dLex);
    const endKeys = new Set([
      completeKey(bestAtDepth[dMin], ctx).join(","),
      completeKey(bestAtDepth[dLex], ctx).join(","),
    ]);
    const cand = [];
    const seen = new Set();
    for (let d = lo + 1; d < hi; d++) {
      const st = bestAtDepth[d];
      if (!st) continue;
      const ks = completeKey(st, ctx).join(",");
      if (endKeys.has(ks) || seen.has(ks)) continue;
      seen.add(ks);
      cand.push({ depth: d, state: st });
    }
    if (!cand.length) return [];
    const want = Math.min(3, cand.length);
    const idxs = [];
    for (let i = 1; i <= want; i++) idxs.push(Math.floor((i * cand.length) / (want + 1)));
    const uniqIdx = Array.from(new Set(idxs)).filter((i) => i >= 0 && i < cand.length);
    return uniqIdx.map((i) => cand[i]);
  }

  /**
   * minRounds 的獨立下界證明：每個可封優先屬性至少要 ceil(剩餘距離/該屬性單輪最大可能加成) 輪
   * 才可能封頂，取所有可封屬性中的最大值。若搜尋找到的 minRoundsDepth 已等於此下界，
   * 不論搜尋過程是否曾束寬剪枝，都可確定是最少輪數（下界成立 = 更快不可能）。
   */
  function minRoundsLowerBound(vectors, ctx, startTotals) {
    let lb = 0;
    for (let i = 0; i < ctx.k; i++) {
      if (!ctx.sealable[i]) continue;
      const remain = ctx.limitsArr[i] - (startTotals[ctx.priAttrs[i]] || 0);
      if (remain <= 0) continue;
      let maxBurst = 0;
      for (const ve of vectors) {
        if (ve.vec[i] > maxBurst) maxBurst = ve.vec[i];
      }
      if (maxBurst <= 0) continue;
      const need = Math.ceil(remain / maxBurst);
      if (need > lb) lb = need;
    }
    return lb;
  }

  /** 在 bestAtDepth[0..budget] 中找完整鍵最大者所在深度（含 0：對應「已全數封頂」等已無可再進步情形） */
  function argmaxDepth(bestAtDepth, budget, ctx) {
    let d = 0;
    for (let dd = 1; dd <= budget; dd++) {
      if (!bestAtDepth[dd]) continue;
      if (lexCompare(completeKey(bestAtDepth[dd], ctx), completeKey(bestAtDepth[d], ctx)) > 0) d = dd;
    }
    return d;
  }

  // ===================== 對外 API =====================

  /**
   * 單軸可達頂（硬上界）：任何方案中屬性 X 的 final ≤ 「(budget-1) 輪內可達的最大 <L 累計」+ 單輪最大增量。
   * 用途：(1) lex 打到全部優先軸的上界 → 束搜結果也可認證；(2) lex 已達某軸上界 → 該軸 peak 免重跑。
   * L 為 null（無上限）或超大時回傳 null（不適用捷徑）。
   */
  function soloPeakValue(vectors, axisIdx, L, start, budget) {
    if (L == null || L > 100000) return null;
    if (start >= L) return start; // 已封，final 固定
    let maxGain = 0;
    const gainSet = new Set();
    for (const V of vectors) {
      const g = V.vec[axisIdx];
      if (g > 0) {
        gainSet.add(g);
        if (g > maxGain) maxGain = g;
      }
    }
    if (!maxGain) return start;
    const gains = Array.from(gainSet);
    // minRounds[s-start] = 從 start 堆到累計 s(<L) 的最少輪數
    const size = L - start;
    const INF = 999999;
    const mr = new Int32Array(size).fill(INF);
    mr[0] = 0;
    const parkRounds = Math.max(0, budget - 1);
    let maxPre = start;
    for (let i = 0; i < size; i++) {
      const r = mr[i];
      if (r >= parkRounds) continue;
      const cur = start + i;
      for (let j = 0; j < gains.length; j++) {
        const nv = cur + gains[j];
        if (nv < L) {
          const ni = nv - start;
          if (r + 1 < mr[ni]) mr[ni] = r + 1;
        }
      }
    }
    for (let i = size - 1; i >= 0; i--) {
      if (mr[i] <= parkRounds) {
        maxPre = start + i;
        break;
      }
    }
    return maxPre + maxGain;
  }

  /**
   * @param {object} input 見檔頭說明／規格
   * @returns {object} { minRounds, lex, tradeoffs, peaks, stats }
   */
  function solve(input) {
    const t0 = Date.now();
    const attrs = input.attrs;
    const parts = input.parts;
    const limits = input.limits;
    const priorities = input.priorities;
    const budget = Math.max(1, Math.min(30, input.budget | 0 || 1));
    const startTotals = input.startTotals || {};
    const pureSail = !!input.pureSail;
    // 預設束寬：實測威尼斯 4 優先屬性 budget=8 招牌案例需要 >=5000(主)/600(peaks) 才能
    // 找到真正最優解（見「效能與束寬」內部筆記）；6000/1500 留安全餘裕。仍可由呼叫端覆寫。
    const beamWidth = input.beamWidth != null ? input.beamWidth : 6000;
    const peakBeamWidth = input.peakBeamWidth != null ? input.peakBeamWidth : 1500;

    const priAttrs = attrs.filter((a) => priorities[a] != null);
    const nonPriAttrs = attrs.filter((a) => priorities[a] == null);
    const stats = { statesExplored: 0, beamTruncated: false, ms: 0 };

    // 無任何優先屬性：無事可做，回空方案
    if (!priAttrs.length) {
      const totals = {};
      for (const a of attrs) totals[a] = startTotals[a] || 0;
      const emptyPlan = { rounds: [], totals, sealedCount: 0, roundCount: 0, key: [] };
      stats.ms = Date.now() - t0;
      return {
        minRounds: null,
        lex: { plan: emptyPlan, provable: true },
        tradeoffs: [],
        peaks: {},
        stats,
      };
    }

    const vectors = precomputeVectors(parts, priAttrs, nonPriAttrs, pureSail);
    // 依 open-mask 去重的向量子表快取：main／peaks 共用（vectors／k 不變，跟分層無關）
    const getSubVectors = makeOpenMaskCache(vectors, priAttrs.length);
    const onProgress = typeof input.onProgress === "function" ? input.onProgress : null;

    // ---- 分流：k 小、packedSize(GCD 縮放後) 小 → 密集精確 DP（不剪枝，provable 恆 true）；否則 beam ----
    const DENSE_THRESHOLD = input.denseThreshold != null ? input.denseThreshold : 4000000;
    const denseInfo = denseEligibility(priAttrs, limits, vectors, startTotals, DENSE_THRESHOLD);
    const useDense = denseInfo != null;
    stats.mode = useDense ? "dense" : "beam";
    stats.packedSize = denseInfo ? denseInfo.packedSize : null;

    // ---- 主層：使用者原始分層，求 minRounds / lex / tradeoffs ----
    const mainTiers = buildTiers(priAttrs, priorities);
    const mainCtx = makeCtx(priAttrs, mainTiers, limits);
    // base/stride／GCD 縮放係數跟分層無關，main／peaks 共用同一份
    const denseIdx = useDense
      ? { ...buildDenseIndex(priAttrs.length, denseInfo.LscaledArr), gArr: denseInfo.gArr, LscaledArr: denseInfo.LscaledArr }
      : null;

    const runOne = (ctx, beamW, wantMin) => {
      const progressCb = onProgress ? (depth) => onProgress({ depth, budget, mode: stats.mode }) : null;
      if (useDense) {
        const layout = computeAccumLayout(ctx, vectors, budget);
        // accum 位元和超過 Float64 安全區（如使用者手填超大上限）→ 打包數字比較會失真，
        // 退回任意精度的通用路徑保正確（runBFS 內部同樣有 52-bit 防線）
        if (layout.totalBits <= 52) {
          return runDense(vectors, ctx, budget, startTotals, wantMin, denseIdx, layout, getSubVectors, progressCb);
        }
      }
      return runBFS(vectors, ctx, budget, startTotals, beamW, wantMin, getSubVectors, progressCb);
    };
    const mkPlan = (state, ctx, run) =>
      buildPlan(state, ctx, parts, attrs, limits, startTotals, run.dense ? { parentLayers: run.parentLayers, vectors: run.vectors } : null);

    const bfs = runOne(mainCtx, beamWidth, true);
    stats.statesExplored += bfs.statesExplored;
    if (bfs.firstTruncatedDepth <= budget) stats.beamTruncated = true;

    let minRounds = null;
    if (bfs.minRoundsDepth != null) {
      const lb = minRoundsLowerBound(vectors, mainCtx, startTotals);
      minRounds = {
        plan: mkPlan(bfs.minRoundsState, mainCtx, bfs),
        provable: bfs.minRoundsDepth < bfs.firstTruncatedDepth || bfs.minRoundsDepth <= lb,
      };
    }

    const dLex = argmaxDepth(bfs.bestAtDepth, budget, mainCtx);
    const lex = {
      plan: mkPlan(bfs.bestAtDepth[dLex], mainCtx, bfs),
      provable: dLex < bfs.firstTruncatedDepth,
    };

    // 單軸硬上界（各優先軸;null=不適用）：peak 免重跑與束搜認證共用
    const soloVals = priAttrs.map((a, i) =>
      soloPeakValue(vectors, i, limits[a], startTotals[a] || 0, budget)
    );
    // 上界命中認證：束搜下若每個優先軸 final 都打到單軸硬上界，優先屬性部分即為最優
    // （非優先順帶值仍屬近似，故用獨立旗標，不冒充完整 provable）
    if (!lex.provable) {
      lex.boundCertified = priAttrs.every(
        (a, i) => soloVals[i] != null && (lex.plan.totals[a] || 0) >= soloVals[i]
      );
    }

    const tradeoffs = pickTradeoffs(bfs.bestAtDepth, bfs.minRoundsDepth, dLex, mainCtx).map((t) => ({
      plan: mkPlan(t.state, mainCtx, bfs),
      provable: t.depth < bfs.firstTruncatedDepth,
    }));

    // ---- 單軸重跑：X 自成 T1、其餘原優先屬性合併 T2，只取 lex（向量池共用，不重算） ----
    const peaks = {};
    for (const X of priAttrs) {
      // lex 已打到該軸單軸硬上界 → 免重跑，直接沿用 lex 方案（該軸 final 可證最高）
      const xi = priAttrs.indexOf(X);
      if (soloVals[xi] != null && (lex.plan.totals[X] || 0) >= soloVals[xi]) {
        peaks[X] = { plan: lex.plan, provable: true, final: lex.plan.totals[X] || 0 };
        continue;
      }
      const rest = priAttrs.filter((a) => a !== X);
      const pTiers = rest.length ? [[X], rest] : [[X]];
      const pCtx = makeCtx(priAttrs, pTiers, limits);
      const pRun = runOne(pCtx, peakBeamWidth, false);
      stats.statesExplored += pRun.statesExplored;
      if (pRun.firstTruncatedDepth <= budget) stats.beamTruncated = true;
      const d = argmaxDepth(pRun.bestAtDepth, budget, pCtx);
      const plan = mkPlan(pRun.bestAtDepth[d], pCtx, pRun);
      peaks[X] = { plan, provable: d < pRun.firstTruncatedDepth, final: plan.totals[X] };
    }

    stats.ms = Date.now() - t0;
    return { minRounds, lex, tradeoffs, peaks, stats };
  }

  // globalThis（非 window）：純函式模組不碰 DOM，須同時能在瀏覽器主執行緒與 Web Worker
  // （無 window，只有 self／globalThis）載入；Node 測試環境 globalThis 即 global，行為一致。
  globalThis.AutoAlloc = { solve };
})();

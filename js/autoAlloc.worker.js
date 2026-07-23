/**
 * 大航海傳說 · 船隻強化模擬器 — 自動配求解器 Web Worker
 *
 * 載入 autoAlloc.js（精確求解器）與 autoAllocLegacy.js（1.0 啟發式引擎，回歸並列顯示用）；
 * 兩者皆純函式模組，不碰 DOM，不需要 data.js——parts/attrs 等資料由主執行緒隨 input 一併傳入。
 * 收到 input 後先跑精確求解 solve()：每層結束回報進度；完成後再跑 AutoAllocLegacy.solve(input)
 * 補產 1.0 方案（包 try/catch，legacy 掛掉不得影響精確結果，失敗則 legacyPlans 回空陣列並附
 * legacyError 字串）。例外時（精確求解本身出錯）回傳錯誤訊息。訊息協定：
 *   主執行緒 → worker：postMessage(input)                                （input 見 autoAlloc.js 檔頭）
 *   worker → 主執行緒：{ type: "progress", depth, budget, mode }         （每層一次，可能多次）
 *                      { type: "done", result, legacyPlans, legacyError }（成功，result 見 solve() 回傳，
 *                                                                          legacyPlans 見 autoAllocLegacy.js，
 *                                                                          legacyError 僅在 legacy 失敗時附上）
 *                      { type: "error", message }                        （精確求解例外，字串訊息）
 */
importScripts("autoAlloc.js", "autoAllocLegacy.js");

onmessage = function (e) {
  const input = e.data || {};
  input.onProgress = function (info) {
    postMessage({ type: "progress", depth: info.depth, budget: info.budget, mode: info.mode });
  };
  try {
    const result = AutoAlloc.solve(input);
    let legacyPlans = [];
    let legacyError;
    try {
      legacyPlans = AutoAllocLegacy.solve(input).plans;
    } catch (legacyErr) {
      legacyPlans = [];
      legacyError = String((legacyErr && legacyErr.message) || legacyErr);
    }
    postMessage({ type: "done", result: result, legacyPlans: legacyPlans, legacyError: legacyError });
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

/**
 * 大航海傳說 · 船隻強化模擬器 — 自動配求解器 Web Worker
 *
 * 只載入 autoAlloc.js（純函式模組，不碰 DOM，不需要 data.js——parts/attrs 等資料由
 * 主執行緒隨 input 一併傳入）。收到 input 後跑 solve()：每層結束回報進度，完成後回傳
 * 結果，例外時回傳錯誤訊息。訊息協定：
 *   主執行緒 → worker：postMessage(input)                                （input 見 autoAlloc.js 檔頭）
 *   worker → 主執行緒：{ type: "progress", depth, budget, mode }         （每層一次，可能多次）
 *                      { type: "done", result }                          （成功，result 見 solve() 回傳）
 *                      { type: "error", message }                        （例外，字串訊息）
 */
importScripts("autoAlloc.js");

onmessage = function (e) {
  const input = e.data || {};
  input.onProgress = function (info) {
    postMessage({ type: "progress", depth: info.depth, budget: info.budget, mode: info.mode });
  };
  try {
    const result = AutoAlloc.solve(input);
    postMessage({ type: "done", result: result });
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

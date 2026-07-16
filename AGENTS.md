# 專案工作約定（給 AI / 協作者）

## 變更流程（固定）

1. 實作功能或規則變更  
2. **自行驗證**（語法、關鍵邏輯、必要時跑小型檢查腳本）  
3. 驗證沒問題 → **直接 commit + push 到 `origin/main`**  
4. **不需要**使用者再提醒「上傳 / 推送 / 部署」

Pages 站台：https://easychiu.github.io/GvlShipEnhance/  
遠端：`git@github.com:easychiu/GvlShipEnhance.git`

## 驗證最低標準

- `node --check` 相關 JS  
- 新規則用簡短斷言覆核（可丟棄臨時腳本，勿提交）  
- 確認不破壞：同輪零件不重複、上限/已封、自動配、船隻上限套用  

## 提交訊息

用清楚的中文或英文摘要「做了什麼」，避免空泛的 update。

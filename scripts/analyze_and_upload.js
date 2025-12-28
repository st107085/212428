/**
 * 檔案：scripts/analyze_and_upload.js
 * 核心 Node.js 腳本，將由 GitHub Actions 執行。
 */

const admin = require('firebase-admin');
const axios = require('axios');
const xml2js = require('xml2js');
const JSZip = require('jszip');

// CWA API 授權碼
const CWA_AUTH_CODE = 'CWA-6096B7FA-48F2-4B95-8FDF-BD8A64E26C71';

// ---------------------- 數據抓取與處理 ----------------------

/** 取得年度地震目錄 (XML) */
async function fetchCurrentYearData() {
    const url = `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/E-A0073-001?Authorization=${CWA_AUTH_CODE}&downloadType=WEB&format=XML`;
    const response = await axios.get(url);
    return await xml2js.parseStringPromise(response.data);
}

/** 取得歷史地震目錄 (ZIP) */
async function fetchHistoryData() {
    const url = `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/E-A0073-002?Authorization=${CWA_AUTH_CODE}&downloadType=WEB&format=ZIP`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const zip = await JSZip.loadAsync(response.data);
    
    // ZIP 內通常只有一個 XML 檔
    const fileName = Object.keys(zip.files)[0];
    const xmlContent = await zip.file(fileName).async('text');
    
    return await xml2js.parseStringPromise(xmlContent);
}

/** 提取地震事件數據 (統一處理) */
function extractEarthquakeEvents(xmlData) {
    // 根據 CWA XML 的結構，通常會在特定的路徑下找到地震列表
    const events = xmlData?.Data?.Earthquake; 
    if (!events) {
        return [];
    }

    return events.map(event => {
        try {
            // 嘗試從 XML 中獲取震度值
            const shindo = event.Shindo ? event.Shindo[0].ShindoValue[0] : null; 
            const location = event.Location? event.Location[0].LocationName[0] : '未知縣市'; 
            const time = event.EarthquakeInfo[0].OriginTime[0]; 
            
            let county = location.substring(0, 3); 
            // 統一處理縣市名稱 (將「臺」統一為「台」)
            if (county.includes('臺')) {
                county = county.replace('臺', '台');
            }
            if (!shindo) {
                return null;
            }

            return {
                time: new Date(time),
                county: county.trim(), 
                shindo: shindo, 
            };
        } catch (e) {
            console.warn("處理單一事件時發生錯誤:", e.message);
            return null;
        }
    }).filter(e => e !== null);
}

// ---------------------- 核心分析邏輯 ----------------------

/** 核心分析邏輯：計算各縣市/各震度的發生頻率並推估未來機率 (泊松分佈簡化模型) */
function analyzeEarthquakeData(allEvents) {
    const now = new Date();
    // 找出最舊的歷史數據時間
    const minHistoryDate = allEvents.reduce((min, e) => e.time < min ? e.time : min, now);
    const totalAnalysisYears = (now.getTime() - minHistoryDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    
    if (totalAnalysisYears < 1) {
         console.warn("歷史數據不足一年，無法進行趨勢分析。");
         return {};
    }

    // 1. 統計各縣市/各震度的發生次數
    const stats = {};
    for (const event of allEvents) {
        const county = event.county;
        const shindo = event.shindo;
        if (!stats[county]) stats[county] = {};
        stats[county][shindo] = (stats[county][shindo] || 0) + 1;
    }

    // 2. 根據歷史頻率計算**年均發生次數 (λ)**，並使用泊松分佈推估機率
    const analysisResults = {};
    const timeIntervals = [1, 3, 6, 9]; 

    for (const [county, shindoCounts] of Object.entries(stats)) {
        analysisResults[county] = {};
        for (const [shindo, count] of Object.entries(shindoCounts)) {
            const lambda = count / totalAnalysisYears; 
            analysisResults[county][shindo] = {};
            
            for (const t of timeIntervals) {
                // 機率 P(X >= 1) = 1 - P(X = 0) = 1 - e^-(λ*t)
                const probability = 1 - Math.exp(-(lambda * t)); 
                // 轉換成百分比，四捨五入到小數點後兩位
                analysisResults[county][shindo][`${t}yr`] = Math.round(probability * 10000) / 100; 
            }
        }
    }

    return analysisResults;
}


// ---------------------- Firebase 寫入邏輯 ----------------------

/** 取得 Firestore 實例 */
function getFirestoreInstance() {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        // 如果沒有金鑰，則無法連線 Admin SDK
        console.error("FIREBASE_SERVICE_ACCOUNT_JSON 環境變數未設定。");
        process.exit(1);
    }
    
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    return admin.firestore();
}

/** 執行所有流程並上傳結果到 Firestore */
async function main() {
    const db = getFirestoreInstance();
    // 嘗試取得觸發者的 GitHub 帳號，否則使用系統預設名稱
    const updaterName = process.env.GITHUB_ACTOR || "GitHub Actions System Automation"; 
    
    try {
        console.log(`[${new Date().toISOString()}] 開始自動更新作業...執行者: ${updaterName}`);
        
        // 1. 抓取 API 資料
        const [currentYearXml, historyXml] = await Promise.all([
            fetchCurrentYearData(),
            fetchHistoryData()
        ]);

        // 2. 提取和合併數據
        const currentEvents = extractEarthquakeEvents(currentYearXml);
        const historyEvents = extractEarthquakeEvents(historyXml);
        const allEvents = [...currentEvents, ...historyEvents];
        
        if (allEvents.length === 0) {
            throw new Error('無法取得任何地震事件資料。');
        }

        // 3. 執行分析
        const analysisData = analyzeEarthquakeData(allEvents);

        // 4. 準備結果
        const updateTime = admin.firestore.Timestamp.now();
        const latestData = {
            updateTime: updateTime,
            updaterName: updaterName, // 紀錄貢獻者 (GitHub 帳號)
            updaterUID: 'system-gh-actions',
            analysisData: analysisData,
            disclaimer: "本分析結果基於中央氣象署歷史地震目錄，採用簡化的泊松分佈模型推估未來發生機率。本數據由 GitHub Actions 系統排程自動更新，不代表即時或官方預測。對於任何依此資訊所做的決定，開發者不承擔任何責任。",
            totalEvents: allEvents.length,
        };

        // 5. 寫入 Firestore: 最新分析結果
        await db.collection('analysis_results').doc('latest').set(latestData);

        // 6. 寫入 Firestore: 更新歷史紀錄
        await db.collection('update_history').add({
            updateTime: updateTime,
            updaterName: updaterName,
            updaterUID: 'system-gh-actions',
            status: 'SUCCESS (Auto)',
            eventCount: allEvents.length
        });
        
        console.log(`數據分析與上傳完成。總事件數: ${allEvents.length}`);

    } catch (error) {
        console.error("自動更新過程中發生嚴重錯誤:", error.message);
        
        // 寫入失敗紀錄
        await db.collection('update_history').add({
            updateTime: admin.firestore.Timestamp.now(),
            updaterName: updaterName,
            updaterUID: 'system-gh-actions',
            status: 'FAILED (Auto)',
            errorMessage: error.message || '未知錯誤'
        });

        process.exit(1); // 讓 GitHub Actions 標記為失敗
    }
}

main();

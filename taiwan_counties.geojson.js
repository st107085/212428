// 檔案：taiwan_counties.geojson.js

window.taiwanCountiesGeoJSON = {
  // *** 請在此處貼上 GeoJSON 資料內容 ***
  "type": "FeatureCollection",
  "features": [
    // ... 包含台灣 22 縣市邊界的 Features ...
    {
      "type": "Feature",
      "properties": { "COUNTYNAME": "臺北市", "COUNTYCODE": "A" },
      "geometry": { "type": "Polygon", "coordinates": [ [ [121.5, 25.0], [121.6, 25.1], [121.5, 25.2], [121.5, 25.0] ] ] }
    },
    // ...
  ]
};

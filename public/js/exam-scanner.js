/* 纯前端扫描全能王引擎（零外部依赖，严格兼容 CSP）：
   - 手机相机拍照 / 相册多图 / 实时取景框检测
   - 自动边缘检测 + 手机防遮挡 2.5× 放大镜四角拖拽
   - 3×3 精确单应性透视变换矫正（双线性插值）
   - 分块高亮背景光照估计去阴影 + 5 档扫描增强滤镜（智能增亮/黑白漂白/高清灰度/原色增强/原图）
   - 支持本地加载后逐页上传至 /api/exam/admin/papers */
(function () {
  "use strict";

  var MAX_SRC_DIM = 2200;
  var MAX_OUT_DIM = 1600;
  var DETECT_DIM = 360;

  function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

  /* ---------- 1. 数学与 3×3 单应矩阵求解 ---------- */
  function solve8x8(A, b) {
    var n = 8;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var col = 0; col < n; col++) {
      var pivot = col;
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      var tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp;
      var div = M[col][col];
      if (Math.abs(div) < 1e-10) return null;
      for (var j = col; j <= n; j++) M[col][j] /= div;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        var f = M[r2][col];
        if (!f) continue;
        for (var j2 = col; j2 <= n; j2++) M[r2][j2] -= f * M[col][j2];
      }
    }
    return M.map(function (row) { return row[n]; });
  }

  // 计算从目标矩形 (0,0)-(W,H) 到源四边形 srcPts 的逆单应矩阵
  function computeHomography(dstPts, srcPts) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = dstPts[i].x, y = dstPts[i].y;
      var u = srcPts[i].x, v = srcPts[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    var h = solve8x8(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function orderQuad(pts) {
    var bySum = pts.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    var byDiff = pts.slice().sort(function (a, b) { return (a.x - a.y) - (b.x - b.y); });
    var tl = bySum[0];
    var br = bySum[bySum.length - 1];
    var bl = byDiff[0];
    var tr = byDiff[byDiff.length - 1];
    return [tl, tr, br, bl];
  }

  function defaultQuad(pad) {
    var p = pad || 0.06;
    return [
      { x: p, y: p },
      { x: 1 - p, y: p },
      { x: 1 - p, y: 1 - p },
      { x: p, y: 1 - p },
    ];
  }

  /* ---------- 2. 自动文档边缘检测 ---------- */
  function pointLineDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(len2);
  }

  function douglasPeucker(pts, eps) {
    if (pts.length <= 2) return pts;
    var maxD = 0, idx = 0;
    var last = pts.length - 1;
    for (var i = 1; i < last; i++) {
      var d = pointLineDist(pts[i], pts[0], pts[last]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
      var left = douglasPeucker(pts.slice(0, idx + 1), eps);
      var right = douglasPeucker(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [pts[0], pts[last]];
  }

  function polyArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(a) * 0.5;
  }

  function isConvexQuad(q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      var cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-5) return false;
      var s = cross > 0 ? 1 : -1;
      if (!sign) sign = s;
      else if (sign !== s) return false;
    }
    return true;
  }

  // 从边缘图找最大闭合外轮廓并尝试逼近成凸四边形
  function findQuadFromEdges(bin, w, h) {
    var visited = new Uint8Array(w * h);
    var dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    var bestQuad = null, bestArea = w * h * 0.12;

    for (var y = 2; y < h - 2; y++) {
      for (var x = 2; x < w - 2; x++) {
        var idx = y * w + x;
        if (!bin[idx] || visited[idx]) continue;

        // BFS 收集连通边缘点
        var queue = [idx];
        visited[idx] = 1;
        var minX = x, maxX = x, minY = y, maxY = y;
        var pts = [];
        for (var qi = 0; qi < queue.length; qi++) {
          var cur = queue[qi];
          var cx = cur % w, cy = (cur - cx) / w;
          pts.push({ x: cx, y: cy });
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (var d = 0; d < 8; d++) {
            var nx = cx + dirs[d][0], ny = cy + dirs[d][1];
            if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
            var nidx = ny * w + nx;
            if (bin[nidx] && !visited[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
        }

        var boxArea = (maxX - minX) * (maxY - minY);
        if (pts.length < 40 || boxArea < bestArea || boxArea > w * h * 0.96) continue;

        // 对边缘点求凸包（Andrew 单调链），再做多边形简化
        pts.sort(function (a, b) { return a.x !== b.x ? a.x - b.x : a.y - b.y; });
        var lower = [];
        for (var i = 0; i < pts.length; i++) {
          while (lower.length >= 2) {
            var p1 = lower[lower.length - 2], p2 = lower[lower.length - 1], p3 = pts[i];
            if ((p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x) <= 0) lower.pop();
            else break;
          }
          lower.push(pts[i]);
        }
        var upper = [];
        for (var j = pts.length - 1; j >= 0; j--) {
          while (upper.length >= 2) {
            var u1 = upper[upper.length - 2], u2 = upper[upper.length - 1], u3 = pts[j];
            if ((u2.x - u1.x) * (u3.y - u1.y) - (u2.y - u1.y) * (u3.x - u1.x) <= 0) upper.pop();
            else break;
          }
          upper.push(pts[j]);
        }
        var hull = lower.slice(0, -1).concat(upper.slice(0, -1));
        if (hull.length < 4) continue;

        var hullArea = polyArea(hull);
        if (hullArea < bestArea) continue;

        var perim = 0;
        for (var k = 0; k < hull.length; k++) {
          var kn = hull[(k + 1) % hull.length];
          perim += Math.hypot(kn.x - hull[k].x, kn.y - hull[k].y);
        }

        // 闭合多边形简化寻找 4 顶点
        for (var factor = 0.015; factor <= 0.08; factor += 0.01) {
          var simplified = douglasPeucker(hull.concat([hull[0]]), perim * factor).slice(0, -1);
          if (simplified.length === 4 && isConvexQuad(simplified)) {
            var qa = polyArea(simplified);
            if (qa >= bestArea && qa < w * h * 0.96) {
              bestArea = qa;
              bestQuad = simplified;
            }
            break;
          }
        }
      }
    }

    if (!bestQuad) return null;
    return orderQuad(bestQuad.map(function (p) {
      return { x: clamp(p.x / w, 0.01, 0.99), y: clamp(p.y / h, 0.01, 0.99) };
    }));
  }

  function detectDocumentQuad(srcCanvas) {
    var sw = srcCanvas.width, sh = srcCanvas.height;
    var scale = Math.min(1, DETECT_DIM / Math.max(sw, sh));
    var w = Math.max(64, Math.round(sw * scale));
    var h = Math.max(64, Math.round(sh * scale));

    var tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    var ctx = tmp.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;

    // 灰度
    var gray = new Float32Array(w * h);
    for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    // 5×5 可分离高斯模糊
    var blurH = new Float32Array(w * h);
    var blur = new Float32Array(w * h);
    var k5 = [1, 4, 6, 4, 1];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = 0;
        for (var k = -2; k <= 2; k++) {
          s += gray[y * w + clamp(x + k, 0, w - 1)] * k5[k + 2];
        }
        blurH[y * w + x] = s / 16;
      }
    }
    for (var y2 = 0; y2 < h; y2++) {
      for (var x2 = 0; x2 < w; x2++) {
        var s2 = 0;
        for (var k2 = -2; k2 <= 2; k2++) {
          s2 += blurH[clamp(y2 + k2, 0, h - 1) * w + x2] * k5[k2 + 2];
        }
        blur[y2 * w + x2] = s2 / 16;
      }
    }

    // Sobel 梯度幅值
    var grad = new Float32Array(w * h);
    var sumG = 0;
    for (var y3 = 1; y3 < h - 1; y3++) {
      for (var x3 = 1; x3 < w - 1; x3++) {
        var tl = blur[(y3 - 1) * w + (x3 - 1)], tc = blur[(y3 - 1) * w + x3], tr = blur[(y3 - 1) * w + (x3 + 1)];
        var ml = blur[y3 * w + (x3 - 1)], mr = blur[y3 * w + (x3 + 1)];
        var bl = blur[(y3 + 1) * w + (x3 - 1)], bc = blur[(y3 + 1) * w + x3], br = blur[(y3 + 1) * w + (x3 + 1)];
        var gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        var gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        var g = Math.abs(gx) + Math.abs(gy);
        grad[y3 * w + x3] = g;
        sumG += g;
      }
    }
    var meanG = sumG / (w * h);
    var varG = 0;
    for (var ig = 0; ig < grad.length; ig++) {
      var dg = grad[ig] - meanG;
      varG += dg * dg;
    }
    var thresh = Math.max(42, meanG + 1.05 * Math.sqrt(varG / grad.length));

    // 二值边缘 + 3×3 膨胀连通断边
    var rawBin = new Uint8Array(w * h);
    for (var ib = 0; ib < grad.length; ib++) rawBin[ib] = grad[ib] >= thresh ? 1 : 0;
    var dil = new Uint8Array(w * h);
    for (var y4 = 1; y4 < h - 1; y4++) {
      for (var x4 = 1; x4 < w - 1; x4++) {
        if (!rawBin[y4 * w + x4]) continue;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) dil[(y4 + dy) * w + (x4 + dx)] = 1;
        }
      }
    }

    return findQuadFromEdges(dil, w, h) || defaultQuad(0.06);
  }

  /* ---------- 3. 精确 3×3 单应透视变换 ---------- */
  function warpPerspective(srcCanvas, quadNorm, lockA4) {
    var sw = srcCanvas.width, sh = srcCanvas.height;
    var pts = quadNorm.map(function (p) { return { x: p.x * sw, y: p.y * sh }; });
    var topW = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    var botW = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y);
    var leftH = Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y);
    var rightH = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);

    var w = Math.max(120, Math.round((topW + botW) * 0.5));
    var h = Math.max(120, Math.round((leftH + rightH) * 0.5));
    if (lockA4) {
      if (h >= w) h = Math.round(w * 1.41421356);
      else w = Math.round(h * 1.41421356);
    }
    var scale = Math.min(1, MAX_OUT_DIM / Math.max(w, h));
    w = Math.max(100, Math.round(w * scale));
    h = Math.max(100, Math.round(h * scale));

    var dstPts = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];
    var H = computeHomography(dstPts, pts);
    var outCanvas = document.createElement("canvas");
    outCanvas.width = w; outCanvas.height = h;
    var octx = outCanvas.getContext("2d", { willReadFrequently: true });
    if (!H) {
      octx.drawImage(srcCanvas, 0, 0, w, h);
      return outCanvas;
    }

    var sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
    var srcImg = sctx.getImageData(0, 0, sw, sh).data;
    var dstImgData = octx.createImageData(w, h);
    var dst = dstImgData.data;

    var h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];
    for (var y = 0; y < h; y++) {
      var rowOff = y * w;
      for (var x = 0; x < w; x++) {
        var den = h6 * x + h7 * y + 1;
        var sx = (h0 * x + h1 * y + h2) / den;
        var sy = (h3 * x + h4 * y + h5) / den;
        var di = (rowOff + x) * 4;

        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
          var cx = clamp(Math.round(sx), 0, sw - 1);
          var cy = clamp(Math.round(sy), 0, sh - 1);
          var ci = (cy * sw + cx) * 4;
          dst[di] = srcImg[ci];
          dst[di + 1] = srcImg[ci + 1];
          dst[di + 2] = srcImg[ci + 2];
          dst[di + 3] = 255;
          continue;
        }

        var x0 = sx | 0, y0 = sy | 0;
        var fx = sx - x0, fy = sy - y0;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        var i00 = (y0 * sw + x0) * 4;
        var i10 = i00 + 4;
        var i01 = i00 + sw * 4;
        var i11 = i01 + 4;

        dst[di] = srcImg[i00] * w00 + srcImg[i10] * w10 + srcImg[i01] * w01 + srcImg[i11] * w11;
        dst[di + 1] = srcImg[i00 + 1] * w00 + srcImg[i10 + 1] * w10 + srcImg[i01 + 1] * w01 + srcImg[i11 + 1] * w11;
        dst[di + 2] = srcImg[i00 + 2] * w00 + srcImg[i10 + 2] * w10 + srcImg[i01 + 2] * w01 + srcImg[i11 + 2] * w11;
        dst[di + 3] = 255;
      }
    }
    octx.putImageData(dstImgData, 0, 0);
    return outCanvas;
  }

  /* ---------- 4. 扫描全能王图像增强滤镜（分块亮纸背景估计 + 锐化） ---------- */
  // 计算每个局部网格内的亮部底色（88 分位亮度），再平滑双线性插值出完整光照底图
  function estimatePaperBackground(data, w, h) {
    var gw = Math.max(8, Math.min(36, Math.round(w / 42)));
    var gh = Math.max(8, Math.min(36, Math.round(h / 42)));
    var gridR = new Float32Array(gw * gh);
    var gridG = new Float32Array(gw * gh);
    var gridB = new Float32Array(gw * gh);
    var hist = new Uint16Array(256);

    for (var gy = 0; gy < gh; gy++) {
      var y0 = Math.floor(gy * h / gh), y1 = Math.floor((gy + 1) * h / gh);
      for (var gx = 0; gx < gw; gx++) {
        var x0 = Math.floor(gx * w / gw), x1 = Math.floor((gx + 1) * w / gw);
        hist.fill(0);
        var cnt = 0;
        var step = (x1 - x0) * (y1 - y0) > 1200 ? 2 : 1;
        for (var y = y0; y < y1; y += step) {
          for (var x = x0; x < x1; x += step) {
            var p = (y * w + x) * 4;
            var lum = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
            hist[lum]++;
            cnt++;
          }
        }
        // 取该块最亮 15% 起步阈值，统计纸张局部平均色（不被黑色字迹拉暗）
        var target = Math.max(1, Math.floor(cnt * 0.85));
        var acc = 0, cut = 200;
        for (var b = 0; b < 256; b++) {
          acc += hist[b];
          if (acc >= target) { cut = b; break; }
        }
        var sr = 0, sg = 0, sb = 0, sc = 0;
        for (var y2 = y0; y2 < y1; y2 += step) {
          for (var x2 = x0; x2 < x1; x2 += step) {
            var p2 = (y2 * w + x2) * 4;
            var lum2 = (data[p2] * 77 + data[p2 + 1] * 150 + data[p2 + 2] * 29) >> 8;
            if (lum2 >= cut) {
              sr += data[p2]; sg += data[p2 + 1]; sb += data[p2 + 2]; sc++;
            }
          }
        }
        var gi = gy * gw + gx;
        gridR[gi] = sc ? Math.max(48, sr / sc) : 220;
        gridG[gi] = sc ? Math.max(48, sg / sc) : 220;
        gridB[gi] = sc ? Math.max(48, sb / sc) : 220;
      }
    }

    // 对背景网格做两次 3×3 均值平滑，消除块边界过渡
    function smoothGrid(g) {
      var out = new Float32Array(gw * gh);
      for (var y = 0; y < gh; y++) {
        for (var x = 0; x < gw; x++) {
          var s = 0, n = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var nx = clamp(x + dx, 0, gw - 1), ny = clamp(y + dy, 0, gh - 1);
              s += g[ny * gw + nx]; n++;
            }
          }
          out[y * gw + x] = s / n;
        }
      }
      return out;
    }
    gridR = smoothGrid(smoothGrid(gridR));
    gridG = smoothGrid(smoothGrid(gridG));
    gridB = smoothGrid(smoothGrid(gridB));

    return { gw: gw, gh: gh, r: gridR, g: gridG, b: gridB };
  }

  function sampleGrid(grid, arr, x, y, w, h) {
    var gx = clamp((x + 0.5) * grid.gw / w - 0.5, 0, grid.gw - 1);
    var gy = clamp((y + 0.5) * grid.gh / h - 0.5, 0, grid.gh - 1);
    var x0 = gx | 0, y0 = gy | 0;
    var x1 = Math.min(grid.gw - 1, x0 + 1), y1 = Math.min(grid.gh - 1, y0 + 1);
    var fx = gx - x0, fy = gy - y0;
    var gw = grid.gw;
    var v00 = arr[y0 * gw + x0], v10 = arr[y0 * gw + x1];
    var v01 = arr[y1 * gw + x0], v11 = arr[y1 * gw + x1];
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }

  function applyFilter(warpedCanvas, mode, brightness, contrast) {
    var w = warpedCanvas.width, h = warpedCanvas.height;
    var out = document.createElement("canvas");
    out.width = w; out.height = h;
    var sctx = warpedCanvas.getContext("2d", { willReadFrequently: true });
    var octx = out.getContext("2d", { willReadFrequently: true });
    var src = sctx.getImageData(0, 0, w, h);
    var s = src.data;
    var dstImg = octx.createImageData(w, h);
    var d = dstImg.data;

    var br = Number(brightness) || 0; // -40..40
    var ct = 1 + (Number(contrast) || 0) / 100; // 0.7..1.5

    if (mode === "original" && br === 0 && ct === 1) {
      octx.drawImage(warpedCanvas, 0, 0);
      return out;
    }

    var bg = (mode === "magic" || mode === "bw" || mode === "gray") ? estimatePaperBackground(s, w, h) : null;

    // 原色增强模式：98 分位白平衡参考
    var wbR = 255, wbG = 255, wbB = 255;
    if (mode === "enhance") {
      var hr = new Uint16Array(256), hg = new Uint16Array(256), hb = new Uint16Array(256), total = 0;
      for (var p = 0; p < s.length; p += 16) { hr[s[p]]++; hg[s[p + 1]]++; hb[s[p + 2]]++; total++; }
      var findP98 = function (hArr) {
        var goal = Math.floor(total * 0.97), acc = 0;
        for (var i = 0; i < 256; i++) { acc += hArr[i]; if (acc >= goal) return Math.max(140, i); }
        return 255;
      };
      wbR = findP98(hr); wbG = findP98(hg); wbB = findP98(hb);
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var idx = (y * w + x) * 4;
        var r = s[idx], g = s[idx + 1], b = s[idx + 2];

        if (mode === "magic") {
          var bgR = sampleGrid(bg, bg.r, x, y, w, h);
          var bgG = sampleGrid(bg, bg.g, x, y, w, h);
          var bgB = sampleGrid(bg, bg.b, x, y, w, h);
          // 除法去阴影漂白：纸张归一化到 ~255，保留红笔/蓝笔/黑字色彩
          r = clamp((r / bgR) * 262, 0, 255);
          g = clamp((g / bgG) * 262, 0, 255);
          b = clamp((b / bgB) * 262, 0, 255);
          // 柔和白点裁剪 + 墨迹加深
          var lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 224 && Math.max(r, g, b) - Math.min(r, g, b) < 28) {
            r = g = b = 255;
          } else {
            r = clamp((r - 228) * 1.18 + 228, 0, 255);
            g = clamp((g - 228) * 1.18 + 228, 0, 255);
            b = clamp((b - 228) * 1.18 + 228, 0, 255);
          }
        } else if (mode === "bw") {
          var bgr = sampleGrid(bg, bg.r, x, y, w, h);
          var bgg = sampleGrid(bg, bg.g, x, y, w, h);
          var bgb = sampleGrid(bg, bg.b, x, y, w, h);
          var nr = clamp((r / bgr) * 255, 0, 255);
          var ng = clamp((g / bgg) * 255, 0, 255);
          var nb = clamp((b / bgb) * 255, 0, 255);
          var l = 0.299 * nr + 0.587 * ng + 0.114 * nb;
          // 平滑局部阈值漂白（抗锯齿字迹）
          var val = l > 205 ? 255 : l < 118 ? 0 : clamp((l - 118) * (255 / 87), 0, 255);
          r = g = b = val;
        } else if (mode === "gray") {
          var gr0 = sampleGrid(bg, bg.r, x, y, w, h);
          var gg0 = sampleGrid(bg, bg.g, x, y, w, h);
          var gb0 = sampleGrid(bg, bg.b, x, y, w, h);
          var gl = 0.299 * (r / gr0) * 258 + 0.587 * (g / gg0) * 258 + 0.114 * (b / gb0) * 258;
          gl = clamp((gl - 215) * 1.15 + 215, 0, 255);
          r = g = b = gl;
        } else if (mode === "enhance") {
          r = clamp((r / wbR) * 255, 0, 255);
          g = clamp((g / wbG) * 255, 0, 255);
          b = clamp((b / wbB) * 255, 0, 255);
          r = clamp((r - 128) * 1.12 + 132, 0, 255);
          g = clamp((g - 128) * 1.12 + 132, 0, 255);
          b = clamp((b - 128) * 1.12 + 132, 0, 255);
        }

        if (br !== 0 || ct !== 1) {
          r = clamp((r - 128) * ct + 128 + br, 0, 255);
          g = clamp((g - 128) * ct + 128 + br, 0, 255);
          b = clamp((b - 128) * ct + 128 + br, 0, 255);
        }

        d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = 255;
      }
    }

    // 扫描件轻度锐化（magic / gray / enhance）
    if (mode === "magic" || mode === "gray" || mode === "enhance") {
      var copy = new Uint8ClampedArray(d);
      var amt = mode === "magic" ? 0.28 : 0.22;
      for (var y3 = 1; y3 < h - 1; y3++) {
        for (var x3 = 1; x3 < w - 1; x3++) {
          var c = (y3 * w + x3) * 4;
          var up = c - w * 4, dn = c + w * 4, lf = c - 4, rt = c + 4;
          for (var ch = 0; ch < 3; ch++) {
            var blur4 = (copy[up + ch] + copy[dn + ch] + copy[lf + ch] + copy[rt + ch]) * 0.25;
            d[c + ch] = clamp(copy[c + ch] + (copy[c + ch] - blur4) * amt, 0, 255);
          }
        }
      }
    }

    octx.putImageData(dstImg, 0, 0);
    return out;
  }

  /* ---------- 5. 图片加载与旋转工具 ---------- */
  function fileToCanvas(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, MAX_SRC_DIM / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
        var w = Math.max(16, Math.round((img.naturalWidth || img.width) * scale));
        var h = Math.max(16, Math.round((img.naturalHeight || img.height) * scale));
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("无法解码所选图片")); };
      img.src = url;
    });
  }

  function rotateCanvas(src, dir) {
    var c = document.createElement("canvas");
    c.width = src.height; c.height = src.width;
    var ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(dir * Math.PI / 2);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  function rotateQuad(quad, dir) {
    return orderQuad(quad.map(function (p) {
      return dir > 0 ? { x: 1 - p.y, y: p.x } : { x: p.y, y: 1 - p.x };
    }));
  }

  /* ---------- 6. 交互式扫描全能王弹窗（管理员专属：扫卷并提交成绩给成员） ---------- */
  function open(opts) {
    if (!opts || opts.isAdmin === false) {
      GS.toast("扫描功能仅限管理员使用");
      return;
    }
    var el = GS.el, icon = GS.icon;
    var queue = []; // { id, name, srcCanvas, quad, filter, brightness, contrast, lockA4, warpedCanvas, enhancedCanvas, annotations }
    var activeIdx = -1;
    var step = "source"; // source | crop | enhance | camera
    var activeDrag = null;
    var pointerPos = null;
    var compareRaw = false;
    var cameraStream = null;
    var cameraRaf = 0;
    var liveQuad = defaultQuad(0.08);
    var annTool = "none"; // none | check | cross | circle

    var extractMode = opts.mode === "extract";
    var hasInitScore = opts.initialScore !== undefined && opts.initialScore !== "" && opts.initialScore !== null;
    var scoreDraft = hasInitScore ? String(opts.initialScore) : "";
    var commentDraft = opts.initialComment || "";
    var syncScore = !!(opts.subject && hasInitScore);
    var aiAutoGrade = !!(!extractMode && opts.subject && opts.aiGradeDefault);

    var dlg = el("dialog", { class: "ui-dialog ui scanner-dialog", "aria-label": extractMode ? "拍照扫卷并识别题型" : "管理员阅卷扫描仪" });
    dlg.setAttribute("data-lenis-prevent", "");

    var titleEl = el("span", { class: "grow", text: extractMode ? "扫描全能王识卷 · 切边去阴影后交由 AI 识别题型" : "管理员阅卷扫描仪 · 拍卷并提交成绩" });
    var closeBtn = el("button", { class: "btn btn-sm btn-invisible", type: "button", "aria-label": "关闭" }, icon("close"));
    var header = el("header", null, icon("phone"), titleEl,
      opts.student ? el("span", { class: "exam-no-pill", text: "考号 " + (opts.student.examNo || "—") }) : null,
      closeBtn);

    var body = el("div", { class: "scanner-body" });
    body.setAttribute("data-lenis-prevent", "");
    var foot = el("footer", { class: "scanner-foot" });
    dlg.append(header, body, foot);
    document.body.appendChild(dlg);

    var camInput = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
    var albumInput = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
    dlg.append(camInput, albumInput);

    function stopCamera() {
      if (cameraRaf) { cancelAnimationFrame(cameraRaf); cameraRaf = 0; }
      if (cameraStream) {
        cameraStream.getTracks().forEach(function (t) { t.stop(); });
        cameraStream = null;
      }
    }

    function cleanup() {
      stopCamera();
      dlg.close();
      dlg.remove();
    }
    closeBtn.addEventListener("click", cleanup);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); cleanup(); });

    function current() { return queue[activeIdx] || null; }

    function addFiles(files) {
      var arr = Array.prototype.slice.call(files || []).filter(function (f) { return f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name); });
      if (!arr.length) return GS.toast("请选择图片文件");
      Promise.all(arr.slice(0, 12).map(function (file) {
        return fileToCanvas(file).then(function (srcCanvas) {
          var quad = detectDocumentQuad(srcCanvas);
          return {
            name: file.name || "试卷",
            srcCanvas: srcCanvas,
            quad: quad,
            filter: "magic",
            brightness: 0,
            contrast: 8,
            lockA4: false,
            warpedCanvas: null,
            enhancedCanvas: null,
            annotations: [],
          };
        });
      })).then(function (items) {
        var wasEmpty = queue.length === 0;
        queue = queue.concat(items);
        if (wasEmpty) activeIdx = 0;
        else activeIdx = queue.length - items.length;
        step = "crop";
        render();
      }).catch(function (err) { GS.toast(err.message || "图片读取失败"); });
    }

    camInput.addEventListener("change", function () { addFiles(camInput.files); camInput.value = ""; });
    albumInput.addEventListener("change", function () { addFiles(albumInput.files); albumInput.value = ""; });

    function startLiveCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        GS.toast("当前浏览器不支持网页实时取景，请点「手机拍照」");
        camInput.click();
        return;
      }
      step = "camera";
      render();
    }

    function drawCropCanvas(canvas) {
      var item = current();
      if (!item) return;
      var src = item.srcCanvas;
      var rect = canvas.parentElement.getBoundingClientRect();
      var maxW = Math.max(280, Math.floor(rect.width - 16));
      var maxH = Math.max(260, Math.min(520, Math.floor(window.innerHeight * 0.54)));
      var scale = Math.min(maxW / src.width, maxH / src.height);
      var dw = Math.max(120, Math.round(src.width * scale));
      var dh = Math.max(120, Math.round(src.height * scale));
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = dw * dpr; canvas.height = dh * dpr;
      canvas.style.width = dw + "px"; canvas.style.height = dh + "px";

      var ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, dw, dh);
      ctx.drawImage(src, 0, 0, dw, dh);

      var q = item.quad.map(function (p) { return { x: p.x * dw, y: p.y * dh }; });

      // 外部遮罩
      ctx.save();
      ctx.fillStyle = "rgba(5, 6, 10, 0.56)";
      ctx.beginPath();
      ctx.rect(0, 0, dw, dh);
      ctx.moveTo(q[0].x, q[0].y);
      ctx.lineTo(q[3].x, q[3].y);
      ctx.lineTo(q[2].x, q[2].y);
      ctx.lineTo(q[1].x, q[1].y);
      ctx.closePath();
      ctx.fill("evenodd");
      ctx.restore();

      // 渐变边框
      var grad = ctx.createLinearGradient(0, 0, dw, dh);
      grad.addColorStop(0, "#7c6cff");
      grad.addColorStop(1, "#22d3ee");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      for (var i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.stroke();

      // 3×3 九宫格辅助线
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1;
      for (var t = 1; t <= 2; t++) {
        var r = t / 3;
        ctx.beginPath();
        ctx.moveTo(q[0].x + (q[3].x - q[0].x) * r, q[0].y + (q[3].y - q[0].y) * r);
        ctx.lineTo(q[1].x + (q[2].x - q[1].x) * r, q[1].y + (q[2].y - q[1].y) * r);
        ctx.moveTo(q[0].x + (q[1].x - q[0].x) * r, q[0].y + (q[1].y - q[0].y) * r);
        ctx.lineTo(q[3].x + (q[2].x - q[3].x) * r, q[3].y + (q[2].y - q[3].y) * r);
        ctx.stroke();
      }

      // 边中点控制点
      for (var e = 0; e < 4; e++) {
        var e2 = (e + 1) % 4;
        var mx = (q[e].x + q[e2].x) * 0.5, my = (q[e].y + q[e2].y) * 0.5;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#7c6cff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }

      // 4 个主顶点手柄
      for (var c = 0; c < 4; c++) {
        var isHit = activeDrag && activeDrag.kind === "corner" && activeDrag.idx === c;
        ctx.fillStyle = isHit ? "#22d3ee" : "#ffffff";
        ctx.strokeStyle = "#7c6cff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(q[c].x, q[c].y, isHit ? 11 : 9, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }

      // 拖动角点时在上方显示 2.5× 放大镜
      if (activeDrag && activeDrag.kind === "corner" && pointerPos) {
        var pt = item.quad[activeDrag.idx];
        var lR = 48;
        var lx = clamp(pt.x * dw, lR + 10, dw - lR - 10);
        var ly = pt.y * dh > lR * 2.4 ? pt.y * dh - lR - 38 : pt.y * dh + lR + 38;
        ly = clamp(ly, lR + 8, dh - lR - 8);

        ctx.save();
        ctx.beginPath();
        ctx.arc(lx, ly, lR, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = "#05060a";
        ctx.fillRect(lx - lR, ly - lR, lR * 2, lR * 2);
        var z = 2.5;
        var srcSize = (lR * 2) / (z * scale);
        ctx.drawImage(
          src,
          pt.x * src.width - srcSize * 0.5, pt.y * src.height - srcSize * 0.5, srcSize, srcSize,
          lx - lR, ly - lR, lR * 2, lR * 2,
        );
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(lx - 14, ly); ctx.lineTo(lx + 14, ly);
        ctx.moveTo(lx, ly - 14); ctx.lineTo(lx, ly + 14);
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(lx, ly, lR, 0, Math.PI * 2);
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    function drawEnhancedPreview(canvas) {
      var item = current();
      if (!item) return;
      var src = compareRaw ? item.warpedCanvas : item.enhancedCanvas;
      if (!src) return;
      canvas.width = src.width;
      canvas.height = src.height;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(src, 0, 0);

      // 绘制红笔预标注
      if (!compareRaw && item.annotations && item.annotations.length) {
        var baseUnit = Math.max(18, Math.round(Math.min(src.width, src.height) * 0.032));
        item.annotations.forEach(function (a) {
          var ax = a.x * src.width, ay = a.y * src.height;
          ctx.save();
          ctx.strokeStyle = a.color || "#ef4444";
          ctx.fillStyle = a.color || "#ef4444";
          ctx.lineWidth = Math.max(3, baseUnit * 0.14);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          if (a.type === "check") {
            ctx.beginPath();
            ctx.moveTo(ax - baseUnit * 0.55, ay);
            ctx.lineTo(ax - baseUnit * 0.1, ay + baseUnit * 0.45);
            ctx.lineTo(ax + baseUnit * 0.75, ay - baseUnit * 0.55);
            ctx.stroke();
          } else if (a.type === "cross") {
            var r = baseUnit * 0.45;
            ctx.beginPath();
            ctx.moveTo(ax - r, ay - r); ctx.lineTo(ax + r, ay + r);
            ctx.moveTo(ax + r, ay - r); ctx.lineTo(ax - r, ay + r);
            ctx.stroke();
          } else if (a.type === "circle") {
            ctx.beginPath();
            ctx.arc(ax, ay, baseUnit * 0.7, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        });
      }
    }

    function processCurrentEnhance(previewCanvas) {
      var item = current();
      if (!item) return;
      if (!item.warpedCanvas) {
        item.warpedCanvas = warpPerspective(item.srcCanvas, item.quad, item.lockA4);
      }
      item.enhancedCanvas = applyFilter(item.warpedCanvas, item.filter, item.brightness, item.contrast);
      if (previewCanvas) drawEnhancedPreview(previewCanvas);
    }

    function renderQueueTabs() {
      if (queue.length <= 1) return null;
      return el("div", { class: "scanner-queue" },
        queue.map(function (it, idx) {
          return el("button", {
            type: "button",
            class: "btn btn-sm " + (idx === activeIdx ? "btn-primary" : ""),
            text: "第 " + (idx + 1) + " 页" + (it.enhancedCanvas ? " ✓" : ""),
            onclick: function () {
              activeIdx = idx;
              if (step === "enhance" && !it.enhancedCanvas) processCurrentEnhance();
              render();
            },
          });
        }),
        el("button", {
          type: "button", class: "btn btn-sm",
          onclick: function () { albumInput.click(); },
        }, icon("plus"), "加拍一页"),
      );
    }

    function render() {
      stopCamera();
      body.textContent = "";
      foot.textContent = "";
      var item = current();

      if (step === "source" || !item && step !== "camera") {
        var drop = el("div", { class: "scanner-dropzone" },
          icon("phone"),
          el("h3", { text: "拍照或导入试卷图片" }),
          el("p", { class: "muted", text: "支持手机直接拍卷子、相册批量选图或桌面拖拽图片，本地自动拉平切边并去阴影漂白。" }),
          el("div", { class: "scanner-source-btns" },
            el("button", { type: "button", class: "btn btn-primary btn-lg", onclick: function () { camInput.click(); } }, icon("phone"), "手机拍照扫描"),
            el("button", { type: "button", class: "btn btn-lg", onclick: function () { albumInput.click(); } }, icon("plus"), "从相册选图（支持多页）"),
            el("button", { type: "button", class: "btn btn-lg", onclick: startLiveCamera }, icon("play"), "网页实时取景"),
          ),
        );
        drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("is-drag"); });
        drop.addEventListener("dragleave", function () { drop.classList.remove("is-drag"); });
        drop.addEventListener("drop", function (e) {
          e.preventDefault(); drop.classList.remove("is-drag");
          addFiles(e.dataTransfer.files);
        });
        body.append(drop);
        foot.append(el("button", { type: "button", class: "btn", text: "取消", onclick: cleanup }));
        return;
      }

      if (step === "camera") {
        var video = el("video", { playsinline: true, muted: true, autoplay: true, class: "scanner-video" });
        var overlay = el("canvas", { class: "scanner-cam-overlay" });
        var wrap = el("div", { class: "scanner-cam-wrap" }, video, overlay);
        var hint = el("p", { class: "muted small", style: "margin:.6rem 0 0;text-align:center", text: "将试卷完整放入画面中，点击快门截取并自动切边" });
        body.append(wrap, hint);

        var shutter = el("button", { type: "button", class: "btn btn-primary btn-lg", text: "📸 拍摄当前页" });
        foot.append(
          el("button", { type: "button", class: "btn", text: "返回", onclick: function () { step = queue.length ? "crop" : "source"; render(); } }),
          shutter,
        );

        navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        }).then(function (stream) {
          cameraStream = stream;
          video.srcObject = stream;
          var probe = document.createElement("canvas");
          var lastDetect = 0;

          function tick(ts) {
            if (!cameraStream) return;
            if (video.videoWidth && video.videoHeight) {
              if (overlay.width !== video.clientWidth || overlay.height !== video.clientHeight) {
                overlay.width = Math.max(1, video.clientWidth);
                overlay.height = Math.max(1, video.clientHeight);
              }
              if (ts - lastDetect > 180) {
                lastDetect = ts;
                probe.width = 280;
                probe.height = Math.max(120, Math.round(280 * video.videoHeight / video.videoWidth));
                probe.getContext("2d").drawImage(video, 0, 0, probe.width, probe.height);
                liveQuad = detectDocumentQuad(probe);
              }
              var octx = overlay.getContext("2d");
              octx.clearRect(0, 0, overlay.width, overlay.height);
              octx.strokeStyle = "#22d3ee";
              octx.lineWidth = 2.5;
              octx.beginPath();
              liveQuad.forEach(function (p, i) {
                var px = p.x * overlay.width, py = p.y * overlay.height;
                if (i === 0) octx.moveTo(px, py); else octx.lineTo(px, py);
              });
              octx.closePath();
              octx.stroke();
            }
            cameraRaf = requestAnimationFrame(tick);
          }
          cameraRaf = requestAnimationFrame(tick);

          shutter.addEventListener("click", function () {
            if (!video.videoWidth) return;
            var cap = document.createElement("canvas");
            var sc = Math.min(1, MAX_SRC_DIM / Math.max(video.videoWidth, video.videoHeight));
            cap.width = Math.round(video.videoWidth * sc);
            cap.height = Math.round(video.videoHeight * sc);
            cap.getContext("2d").drawImage(video, 0, 0, cap.width, cap.height);
            var quad = detectDocumentQuad(cap);
            queue.push({
              name: "相机拍摄",
              srcCanvas: cap,
              quad: quad,
              filter: "magic",
              brightness: 0,
              contrast: 8,
              lockA4: false,
              warpedCanvas: null,
              enhancedCanvas: null,
              annotations: [],
            });
            activeIdx = queue.length - 1;
            step = "crop";
            render();
          });
        }).catch(function () {
          GS.toast("无法调用网页相机，请使用系统相机拍照");
          step = queue.length ? "crop" : "source";
          render();
        });
        return;
      }

      if (step === "crop") {
        var qBar = renderQueueTabs();
        if (qBar) body.append(qBar);

        var stage = el("div", { class: "scanner-stage" });
        var canvas = el("canvas", { class: "scanner-canvas" });
        stage.append(canvas);

        var tools = el("div", { class: "scanner-tools" },
          el("button", { type: "button", class: "btn btn-sm", text: "自动切边", onclick: function () {
            item.quad = detectDocumentQuad(item.srcCanvas);
            item.warpedCanvas = null; item.enhancedCanvas = null;
            drawCropCanvas(canvas);
          } }),
          el("button", { type: "button", class: "btn btn-sm", text: "全图范围", onclick: function () {
            item.quad = defaultQuad(0.01);
            item.warpedCanvas = null; item.enhancedCanvas = null;
            drawCropCanvas(canvas);
          } }),
          el("button", { type: "button", class: "btn btn-sm", text: "左旋 90°", onclick: function () {
            item.srcCanvas = rotateCanvas(item.srcCanvas, -1);
            item.quad = rotateQuad(item.quad, -1);
            item.warpedCanvas = null; item.enhancedCanvas = null;
            drawCropCanvas(canvas);
          } }),
          el("button", { type: "button", class: "btn btn-sm", text: "右旋 90°", onclick: function () {
            item.srcCanvas = rotateCanvas(item.srcCanvas, 1);
            item.quad = rotateQuad(item.quad, 1);
            item.warpedCanvas = null; item.enhancedCanvas = null;
            drawCropCanvas(canvas);
          } }),
          el("label", { class: "scanner-check" },
            el("input", { type: "checkbox", checked: item.lockA4, onchange: function () {
              item.lockA4 = this.checked;
              item.warpedCanvas = null; item.enhancedCanvas = null;
            } }),
            "锁定 A4 比例",
          ),
        );

        body.append(stage, tools,
          el("p", { class: "muted small", style: "margin:.4rem 0 0;text-align:center", text: "拖动四角或边中点精准框选试卷边缘（拖动时自动出现放大镜）" }));

        requestAnimationFrame(function () { drawCropCanvas(canvas); });

        function toNorm(e) {
          var r = canvas.getBoundingClientRect();
          return { x: clamp((e.clientX - r.left) / r.width, 0.005, 0.995), y: clamp((e.clientY - r.top) / r.height, 0.005, 0.995), rect: r };
        }

        canvas.addEventListener("pointerdown", function (e) {
          var p = toNorm(e);
          var hitPx = 28;
          var best = null, bestD = hitPx;
          item.quad.forEach(function (pt, idx) {
            var d = Math.hypot((pt.x - p.x) * p.rect.width, (pt.y - p.y) * p.rect.height);
            if (d < bestD) { bestD = d; best = { kind: "corner", idx: idx }; }
          });
          if (!best) {
            for (var i = 0; i < 4; i++) {
              var j = (i + 1) % 4;
              var mx = (item.quad[i].x + item.quad[j].x) * 0.5, my = (item.quad[i].y + item.quad[j].y) * 0.5;
              var d2 = Math.hypot((mx - p.x) * p.rect.width, (my - p.y) * p.rect.height);
              if (d2 < hitPx) {
                best = { kind: "edge", i: i, j: j, startP: p, a0: Object.assign({}, item.quad[i]), b0: Object.assign({}, item.quad[j]) };
                break;
              }
            }
          }
          if (!best) return;
          activeDrag = best;
          pointerPos = p;
          canvas.setPointerCapture(e.pointerId);
          drawCropCanvas(canvas);
        });

        canvas.addEventListener("pointermove", function (e) {
          if (!activeDrag) return;
          var p = toNorm(e);
          pointerPos = p;
          if (activeDrag.kind === "corner") {
            item.quad[activeDrag.idx] = { x: p.x, y: p.y };
          } else {
            var dx = p.x - activeDrag.startP.x, dy = p.y - activeDrag.startP.y;
            item.quad[activeDrag.i] = { x: clamp(activeDrag.a0.x + dx, 0.005, 0.995), y: clamp(activeDrag.a0.y + dy, 0.005, 0.995) };
            item.quad[activeDrag.j] = { x: clamp(activeDrag.b0.x + dx, 0.005, 0.995), y: clamp(activeDrag.b0.y + dy, 0.005, 0.995) };
          }
          item.warpedCanvas = null; item.enhancedCanvas = null;
          drawCropCanvas(canvas);
        });

        function endDrag(e) {
          if (!activeDrag) return;
          activeDrag = null; pointerPos = null;
          try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
          drawCropCanvas(canvas);
        }
        canvas.addEventListener("pointerup", endDrag);
        canvas.addEventListener("pointercancel", endDrag);

        foot.append(
          el("button", { type: "button", class: "btn", text: "重选图片", onclick: function () { queue = []; activeIdx = -1; step = "source"; render(); } }),
          el("span", { class: "grow" }),
          el("button", { type: "button", class: "btn btn-primary", text: "下一步：透视拉平与扫描增强 →", onclick: function () {
            item.warpedCanvas = warpPerspective(item.srcCanvas, item.quad, item.lockA4);
            processCurrentEnhance();
            step = "enhance";
            render();
          } }),
        );
        return;
      }

      if (step === "enhance") {
        var qBar2 = renderQueueTabs();
        if (qBar2) body.append(qBar2);

        var stage2 = el("div", { class: "scanner-stage" });
        var prevCanvas = el("canvas", { class: "scanner-canvas scanner-preview-canvas" });
        stage2.append(prevCanvas);

        if (!item.enhancedCanvas) processCurrentEnhance();
        drawEnhancedPreview(prevCanvas);

        // 支持直接在增强后的扫描件上点选红笔批改标记
        prevCanvas.addEventListener("click", function (e) {
          if (annTool === "none") return;
          var r = prevCanvas.getBoundingClientRect();
          item.annotations.push({
            type: annTool,
            x: clamp((e.clientX - r.left) / r.width, 0.02, 0.98),
            y: clamp((e.clientY - r.top) / r.height, 0.02, 0.98),
            color: "#ef4444",
          });
          drawEnhancedPreview(prevCanvas);
        });

        var filters = [
          { id: "magic", label: "智能增亮（推荐）" },
          { id: "bw", label: "黑白漂白" },
          { id: "gray", label: "高清灰度" },
          { id: "enhance", label: "原色增强" },
          { id: "original", label: "原图矫正" },
        ];
        var filterBar = el("div", { class: "scanner-filters" },
          filters.map(function (f) {
            return el("button", {
              type: "button",
              class: "btn btn-sm " + (item.filter === f.id ? "btn-primary" : ""),
              text: f.label,
              onclick: function () {
                item.filter = f.id;
                processCurrentEnhance(prevCanvas);
                filterBar.querySelectorAll("button").forEach(function (b, idx) {
                  b.classList.toggle("btn-primary", filters[idx].id === f.id);
                });
              },
            });
          }),
        );

        var brInput = el("input", { type: "range", min: -40, max: 40, value: item.brightness });
        var ctInput = el("input", { type: "range", min: -30, max: 50, value: item.contrast });
        var debounceTimer;
        function scheduleTune() {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(function () { processCurrentEnhance(prevCanvas); }, 60);
        }
        brInput.addEventListener("input", function () { item.brightness = Number(this.value); scheduleTune(); });
        ctInput.addEventListener("input", function () { item.contrast = Number(this.value); scheduleTune(); });

        var cmpBtn = el("button", { type: "button", class: "btn btn-sm", text: "按住对比原图" });
        cmpBtn.addEventListener("pointerdown", function () { compareRaw = true; drawEnhancedPreview(prevCanvas); });
        cmpBtn.addEventListener("pointerup", function () { compareRaw = false; drawEnhancedPreview(prevCanvas); });
        cmpBtn.addEventListener("pointerleave", function () { if (compareRaw) { compareRaw = false; drawEnhancedPreview(prevCanvas); } });

        var annBar = el("div", { class: "scanner-ann-bar" },
          el("span", { class: "small muted", text: "红笔预批改：" }),
          [
            { id: "none", label: "浏览" },
            { id: "check", label: "✓ 打勾" },
            { id: "cross", label: "✗ 打叉" },
            { id: "circle", label: "○ 圈画" },
          ].map(function (t) {
            return el("button", {
              type: "button",
              class: "btn btn-sm " + (annTool === t.id ? "is-on" : ""),
              text: t.label,
              onclick: function () {
                annTool = t.id;
                annBar.querySelectorAll("button[data-tool]").forEach(function (b) {
                  b.classList.toggle("is-on", b.dataset.tool === annTool);
                });
              },
              dataset: { tool: t.id },
            });
          }),
          el("button", { type: "button", class: "btn btn-sm", text: "撤销红笔", onclick: function () {
            item.annotations.pop();
            drawEnhancedPreview(prevCanvas);
          } }),
        );

        var tuneBar = el("div", { class: "scanner-tunes" },
          el("label", null, "亮度 ", brInput),
          el("label", null, "对比度 ", ctInput),
          cmpBtn,
        );

        var uploadBtn = el("button", {
          type: "button", class: "btn btn-primary",
          text: "",
        });

        var scoreInp = el("input", {
          type: "number", step: "0.5", min: "0",
          max: opts.subject ? opts.subject.fullScore : 1000,
          value: scoreDraft,
          placeholder: opts.subject ? "0–" + opts.subject.fullScore : "输入分数",
        });
        var commentInp = el("input", {
          type: "text", maxlength: "500",
          value: commentDraft,
          placeholder: "教师评语（可选）",
        });
        var syncScoreChk = el("input", { type: "checkbox", checked: syncScore });
        var aiGradeChk = el("input", { type: "checkbox", checked: aiAutoGrade });

        function updateUploadBtnText() {
          if (extractMode) {
            uploadBtn.textContent = queue.length > 1
              ? "用这 " + queue.length + " 页 AI 识别题型"
              : "提交给 AI 识别题型";
            return;
          }
          if (opts.subject && aiGradeChk.checked) {
            uploadBtn.textContent = queue.length > 1
              ? "上传答题卡并 AI 自动批改（" + queue.length + " 页）"
              : "上传答题卡并 AI 自动批改";
            return;
          }
          var willSync = !!(opts.subject && syncScoreChk.checked && scoreInp.value.trim() !== "");
          if (willSync) {
            uploadBtn.textContent = queue.length > 1
              ? "上传扫描件并提交成绩（" + queue.length + " 页）"
              : "上传扫描件并提交成绩";
          } else {
            uploadBtn.textContent = queue.length > 1
              ? "仅上传扫描件（" + queue.length + " 页）"
              : "仅保存并上传扫描件";
          }
        }
        scoreInp.addEventListener("input", function () {
          scoreDraft = this.value;
          if (this.value.trim() !== "") {
            syncScoreChk.checked = true;
            aiAutoGrade = false;
            aiGradeChk.checked = false;
          }
          syncScore = syncScoreChk.checked;
          updateUploadBtnText();
        });
        commentInp.addEventListener("input", function () { commentDraft = this.value; });
        syncScoreChk.addEventListener("change", function () {
          syncScore = this.checked;
          if (syncScore) { aiAutoGrade = false; aiGradeChk.checked = false; }
          updateUploadBtnText();
        });
        aiGradeChk.addEventListener("change", function () {
          aiAutoGrade = this.checked;
          if (aiAutoGrade) { syncScore = false; syncScoreChk.checked = false; }
          updateUploadBtnText();
        });
        updateUploadBtnText();

        var scoreBox = (!extractMode && opts.subject) ? el("div", { class: "scanner-score-box" },
          el("div", { class: "scanner-score-head" },
            el("strong", { text: "提交给成员：" + ((opts.student && (opts.student.displayName || opts.student.username)) || "") + (opts.student && opts.student.examNo ? "（考号 " + opts.student.examNo + "）" : "") }),
            el("span", { class: "small muted", text: opts.subject.name + " · 满分 " + opts.subject.fullScore + (opts.examStatus === "draft" ? " · 当前为草稿考试" : "") }),
          ),
          el("div", { class: "scanner-score-fields" },
            el("label", { class: "scanner-score-field" }, el("span", { text: "本次得分" }), scoreInp),
            el("label", { class: "scanner-score-field grow" }, el("span", { text: "教师评语" }), commentInp),
          ),
          el("div", { class: "row", style: "gap:1rem" },
            el("label", { class: "scanner-check" }, aiGradeChk, "🤖 上传后由 DeepSeek AI 自动批改、判分并生成红笔批注"),
            el("label", { class: "scanner-check" }, syncScoreChk, "改为手动提交上方填写成绩"),
          ),
        ) : null;

        body.append(stage2, filterBar, tuneBar);
        if (!extractMode) body.append(annBar);
        if (scoreBox) body.append(scoreBox);

        uploadBtn.addEventListener("click", function () {
          if (extractMode) {
            var pagesOut = queue.map(function (it, idx) {
              if (!it.warpedCanvas) it.warpedCanvas = warpPerspective(it.srcCanvas, it.quad, it.lockA4);
              if (!it.enhancedCanvas) it.enhancedCanvas = applyFilter(it.warpedCanvas, it.filter, it.brightness, it.contrast);
              return { pageNo: idx + 1, imageData: it.enhancedCanvas.toDataURL("image/jpeg", 0.86) };
            });
            cleanup();
            if (opts.onExtract) opts.onExtract(pagesOut);
            return;
          }
          var useAiGrade = !!(opts.subject && aiGradeChk.checked);
          var willSync = !useAiGrade && !!(opts.subject && syncScoreChk.checked && scoreInp.value.trim() !== "");
          var scoreVal = Number(scoreInp.value);
          if (willSync && (!Number.isFinite(scoreVal) || scoreVal < 0 || scoreVal > opts.subject.fullScore)) {
            GS.toast("请输入 0–" + opts.subject.fullScore + " 之间的有效分数");
            scoreInp.focus();
            return;
          }
          var done = GS.busy(uploadBtn, "正在上传…");
          var basePageNo = Number(opts.nextPageNo) || 1;
          // 保证队列中所有页都完成透视和滤镜增强
          var tasks = queue.map(function (it, idx) {
            if (!it.warpedCanvas) it.warpedCanvas = warpPerspective(it.srcCanvas, it.quad, it.lockA4);
            if (!it.enhancedCanvas) it.enhancedCanvas = applyFilter(it.warpedCanvas, it.filter, it.brightness, it.contrast);
            return { item: it, pageNo: basePageNo + idx };
          });

          tasks.reduce(function (p, t, idx) {
            return p.then(function (uploadedList) {
              uploadBtn.textContent = "上传扫描件 (" + (idx + 1) + "/" + tasks.length + ")…";
              var dataUrl = t.item.enhancedCanvas.toDataURL("image/jpeg", 0.86);
              return GS.api("POST", "/api/exam/admin/papers", {
                examId: opts.examId,
                subjectId: opts.subjectId,
                userId: opts.student.id,
                pageNo: t.pageNo,
                imageData: dataUrl,
                width: t.item.enhancedCanvas.width,
                height: t.item.enhancedCanvas.height,
                filterMode: t.item.filter,
                annotations: t.item.annotations,
              }).then(function (r) {
                uploadedList.push(r.page);
                return uploadedList;
              });
            });
          }, Promise.resolve([])).then(function (uploadedPages) {
            if (useAiGrade) {
              uploadBtn.textContent = "DeepSeek AI 正在自动阅卷批改…";
              return GS.api("POST", "/api/exam/admin/ai-grade", {
                examId: opts.examId,
                subjectId: opts.subjectId,
                userId: opts.student.id,
                applyAnnotations: true,
                autoSave: true,
              }).then(function (gr) {
                return { uploadedPages: uploadedPages, syncedScore: true, aiGrading: gr.grading };
              });
            }
            if (!willSync) return { uploadedPages: uploadedPages, syncedScore: false };
            uploadBtn.textContent = "正在提交成绩给成员…";
            var payload = {
              userId: opts.student.id,
              subjectId: opts.subjectId,
              score: scoreVal,
              absent: false,
              teacherComment: commentInp.value.trim(),
            };
            if (Array.isArray(opts.items) && opts.items.length) {
              payload.items = opts.items;
              payload.useItemsSum = false;
            }
            return GS.api("PUT", "/api/exam/admin/exams/" + opts.examId + "/scores", payload).then(function () {
              return { uploadedPages: uploadedPages, syncedScore: true };
            });
          }).then(function (res) {
            if (res.aiGrading) {
              GS.toast("AI 已批改完成：实得 " + res.aiGrading.score + " / " + res.aiGrading.fullScore + " 分（已生成红笔批注与错题本）");
            } else {
              GS.toast(res.syncedScore
                ? "已上传 " + res.uploadedPages.length + " 页扫描试卷并提交成绩给成员"
                : "已上传 " + res.uploadedPages.length + " 页扫描试卷");
            }
            cleanup();
            if (opts.onUploaded) opts.onUploaded(res.uploadedPages, res.syncedScore, res.aiGrading);
          }).catch(function (err) {
            done();
            updateUploadBtnText();
            if (!err.cancelled) GS.toast(err.message || "上传失败");
          });
        });

        foot.append(
          el("button", { type: "button", class: "btn", text: "← 返回重新切边", onclick: function () { step = "crop"; render(); } }),
          el("span", { class: "grow" }),
          uploadBtn,
        );
      }
    }

    render();
    dlg.showModal();
  }

  window.ExamScanner = {
    open: open,
    detectDocumentQuad: detectDocumentQuad,
    warpPerspective: warpPerspective,
    applyFilter: applyFilter,
  };
})();

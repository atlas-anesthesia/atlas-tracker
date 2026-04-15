// -- anesthesia.js — Print Record PDF generator ------------------------------
// Depends on: app.js (window.currentWorker)
// Requires: anesthesia-record.pdf in GitHub repo root


// -- ANESTHESIA RECORD PDF GENERATOR (overlays onto exact sheet) ---------------
let _anesPdfBytes = null;

async function _loadAnesPdf() {
  if(_anesPdfBytes) return _anesPdfBytes;
  const res = await fetch('./anesthesia-record.pdf');
  if(!res.ok) throw new Error('Could not load anesthesia-record.pdf — upload it to GitHub alongside app.js');
  const buf = await res.arrayBuffer();
  _anesPdfBytes = new Uint8Array(buf);
  return _anesPdfBytes;
}

window.generateAnesthesiaRecord = async function(record, previewOnly) {
  const r = record || {};
  const { PDFDocument, rgb, StandardFonts } = PDFLib;

  const pdfBytes = await _loadAnesPdf();
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPages()[1]; // Page 2 = back side
  const H = page.getHeight();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const chk = k => !!r[k];
  const val = k => String(r[k] || '');
  const Y = py => H - py;

  // Draw X inside checkbox — tx/ty are the label text position in pymupdf coords
  // Offset: x = label_x - 12 (checkbox is left of label)
  //         y = Y(ty) + 4  (shifted down 5pt to center in checkbox square)
  // cx, cy = EXACT checkbox center in pymupdf coords (extracted from template)
  const drawX = (cx, cy) => {
    page.drawText('X', {
      x: cx - 2.5,            // center X char (X glyph ~5pt wide at size 6)
      y: (792 - cy) - 2.5,    // center X char vertically in 6pt checkbox
      size: 6, font: fontBold, color: rgb(0,0,0)
    });
  };

  // Draw plain text
  const drawT = (text, x, py, size, bold) => {
    if(!text) return;
    page.drawText(String(text).substring(0, 90), {
      x, y: Y(py) - 1, size: size || 7.5,
      font: bold ? fontBold : font, color: rgb(0,0,0)
    });
  };

  // Draw wrapped text with a Y-cutoff to prevent overflow into next section
  const drawWrap = (text, x, startPy, maxChars, lineH, maxY) => {
    if(!text) return;
    const words = String(text).split(' ');
    let line = '', cy = Y(startPy) - 1;
    const minY = maxY ? Y(maxY) + 4 : 0;
    words.forEach(w => {
      if((line + ' ' + w).trim().length > maxChars) {
        if(cy > minY) page.drawText(line.trim(), {x, y: cy, size: 6.5, font, color: rgb(0,0,0)});
        cy -= lineH; line = w;
      } else { line = (line + ' ' + w).trim(); }
    });
    if(line && cy > minY) page.drawText(line.trim(), {x, y: cy, size: 6.5, font, color: rgb(0,0,0)});
  };

  // Horizontal flowing text — joins items with ", " then wraps across full box width
  const drawWrap2Col = (text, x1, x2, startPy, stopPy, fs) => {
    if(!text) return;
    const items = text.split(/[\n]+/).map(s=>s.trim()).filter(Boolean);
    const joined = items.join(', ');
    const boxW = 273; // pt available (x=32 to x=305, left half of page)
    const fontSize = fs || 6;
    // Approx chars per line: boxW / (fontSize * 0.55)
    const charsPerLine = Math.floor(boxW / (fontSize * 0.55));
    const topY = Y(startPy) - 1;
    const bottomY = Y(stopPy) + 4;
    const lineH = fontSize + 2;
    // Word-wrap the joined string
    const words = joined.split(' ');
    let line = '', cy = topY;
    words.forEach(w => {
      const test = line ? line + ' ' + w : w;
      if(test.length > charsPerLine && line) {
        if(cy > bottomY) page.drawText(line, {x: x1, y: cy, size: fontSize, font, color: rgb(0,0,0)});
        cy -= lineH;
        line = w;
      } else {
        line = test;
      }
    });
    if(line && cy > bottomY) page.drawText(line, {x: x1, y: cy, size: fontSize, font, color: rgb(0,0,0)});
  }

  // ALLERGIES (box: y=37 to y=114 in pymupdf, content area y=44-110)
  drawWrap2Col(val('po-allergies'), 32, 165, 52, 112, 6.5);

  // PUPIL EXAM y=133
  if(chk('po-pupil-normal'))      drawX(101.5,137.9);
  if(chk('po-pupil-dilated'))     drawX(159.3,138.2);
  if(chk('po-pupil-constricted')) drawX(217.7,137.9);

  // CARDIOVASCULAR y=156
  if(chk('po-cv-neg'))     drawX(116.7,160.4); if(chk('po-cv-htn'))    drawX(147.0,160.2);
  if(chk('po-cv-cad'))     drawX(177.2,160.8); if(chk('po-cv-angina')) drawX(206.2,160.6);
  if(chk('po-cv-mi'))      drawX(248.7,160.6); if(chk('po-cv-chf'))    drawX(270.7,160.6);
  // row 2 y=171
  if(chk('po-cv-murmur'))    drawX(105.1,175.6);
  if(chk('po-cv-arrythmia')) drawX(156.4,175.4);
  drawT(val('po-cv-other'), 245, 171, 7);

  // EKG y=192
  if(chk('po-ekg-nsr'))   drawX(66.9,196.0); if(chk('po-ekg-afib'))  drawX(98.4,196.0);
  if(chk('po-ekg-bbb'))   drawX(130.7,196.0); if(chk('po-ekg-lvh'))   drawX(161.2,196.0);
  if(chk('po-ekg-chngs')) drawX(190.8,195.9);

  // PULMONARY y=214
  if(chk('po-pulm-neg'))        drawX(97.2,218.9); if(chk('po-pulm-asthma'))     drawX(130.6,218.9);
  if(chk('po-pulm-copd'))       drawX(175.8,218.9); if(chk('po-pulm-uri'))        drawX(209.9,218.9);
  if(chk('po-pulm-o2cpap'))     drawX(236.4,218.9);
  if(chk('po-pulm-sleepapnea')) drawX(95.9,230.9);
  if(chk('po-pulm-blbs'))       drawX(159.7,230.9);
  if(chk('po-pulm-smoker'))     drawX(246.5,230.9);

  // GASTRO y=247
  if(chk('po-gi-neg'))      drawX(85.7,251.5); if(chk('po-gi-gerd'))     drawX(117.8,251.5);
  if(chk('po-gi-hiathern')) drawX(152.6,251.5); if(chk('po-gi-ulcer'))    drawX(206.6,251.5);

  // RENAL y=267
  if(chk('po-renal-neg'))      drawX(85.5,271.9);
  if(chk('po-renal-dialysis')) drawX(117.7,271.8);
  if(chk('po-renal-esrd'))     drawX(165.4,271.8);

  // NEURO y=285
  if(chk('po-neuro-neg'))        drawX(85.6,289.9);
  if(chk('po-neuro-depression')) drawX(117.8,289.9);
  if(chk('po-neuro-anxiety'))    drawX(178.8,289.9);
  if(chk('po-neuro-seizures'))   drawX(262.4,289.9);
  if(chk('po-neuro-cva'))        drawX(86.0,303.3);
  if(chk('po-neuro-nmdisease'))  drawX(116.8,303.3);

  // METABOLIC y=319
  if(chk('po-met-neg'))     drawX(95.8,323.8); if(chk('po-met-iddm'))    drawX(128.7,323.8);
  if(chk('po-met-niddm'))   drawX(163.2,323.8); if(chk('po-met-thyroid')) drawX(204.2,323.8);
  if(chk('po-met-hep'))     drawX(252.9,323.8);
  if(chk('po-met-obesity'))       drawX(95.8,338.2);
  if(chk('po-met-morbidobesity')) drawX(143.7,338.2);

  // TEETH y=352
  if(chk('po-teeth-intact'))  drawX(72.8,356.1);
  if(chk('po-teeth-missing')) drawX(115.4,356.1);
  if(chk('po-teeth-denture')) drawX(161.1,356.1);

  // OTHER y=371
  if(chk('po-other-hiv'))       drawX(76.5,375.3); if(chk('po-other-hepc'))     drawX(105.5,375.3);
  if(chk('po-other-anemia'))    drawX(143.5,375.3); if(chk('po-other-steroids'))  drawX(187.4,375.3);
  if(chk('po-other-cancers'))   drawX(238.2,375.3);
  if(chk('po-other-drugabuse')) drawX(76.3,388.7);
  if(chk('po-other-coag'))      drawX(138.1,388.7);
  if(chk('po-other-chemo'))     drawX(214.2,388.7);

  // MEDICATIONS box: y=402 to y=449 → content: start y=412, stop before y=447
  drawWrap2Col(val('po-medications'), 32, 165, 420, 445, 6);

  // SURGICAL HISTORY box: y=449 to y=477 → content: start y=456, stop before y=475
  drawWrap2Col(val('po-surgicalHistory'), 32, 165, 467, 475, 6);

  // PHYSICAL ASSESSMENT
  drawT(val('po-assessTime'), 408, 477, 7.5);
  // VSS / A+0x3 / QUESTIONS ANSWERED — always mark when record is filled
  drawX(45.4,495.2); drawX(80.0,495.2); drawX(119.4,495.2);

  if(chk('po-heart-wnl')) drawX(81.4, 512.5);
  drawT(val('po-heart-notes'), 115, 508, 7.5);
  if(chk('po-lungs-wnl')) drawX(82.1, 527.1);
  drawT(val('po-lungs-notes'), 115, 522, 7.5);
  if(chk('po-abd-wnl'))  drawX(145.2, 541.4);
  drawT(val('po-abd-notes'),   200, 537, 7.5);

  // MALLAMPATI
  const mp = val('mallampati');
  if(mp==='1') drawX(130.0,554.0); if(mp==='2') drawX(146.0,554.0);
  if(mp==='3') drawX(161.0,554.0); if(mp==='4') drawX(176.0,554.0);

  // VENIPUNCTURE / TOTAL FLUIDS / EBL y=570
  drawT(val('po-venipuncture'), 80,  570, 7.5);
  drawT(val('po-totalFluids'),  240, 570, 7.5);
  drawT(val('po-ebl'),          280, 570, 7.5);

  // RIGHT COLUMN — PRE-OP CALL INFORMATION
  const surgDate = val('po-surgeryDate') ? new Date(val('po-surgeryDate')+'T12:00:00Z').toLocaleDateString('en-US') : '';
  drawT(surgDate, 450, 76, 7.5);

  const callDT = val('po-callDateTime');
  let callFmt = '';
  if(callDT) {
    const d = new Date(callDT.includes('T') ? callDT : callDT+'T00:00');
    callFmt = d.toLocaleDateString('en-US') + (callDT.includes('T') ? ' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '');
  }
  drawT(callFmt, 435, 96, 7.5); // PRE-OP INSTRUCTIONS CONFIRMED
  if(chk('po-npo'))    drawX(349.9,142.6);
  if(chk('po-driver')) drawX(349.9,171.4);
  drawT(val('po-driverName'), 440, 184, 7.5);
  drawT(val('po-driverRel'),  440, 196, 7.5);
  if(chk('po-nodrive')) drawX(349.9,210.0);

  // COMMENTS right column y≈264
  drawWrap(val('po-comments'), 315, 278, 36, 9, 330);

  // Provider name near signature
  const w = r.worker || (typeof window.currentWorker !== 'undefined' ? window.currentWorker : 'josh');
  drawT(w==='josh' ? 'Josh Condado, CRNA' : 'Dr. Dev Murthy, CRNA', 30, 756, 7, true);

  // Output
  const outBytes = await pdfDoc.save();
  const blob = new Blob([outBytes], {type:'application/pdf'});
  const url = URL.createObjectURL(blob);
  if(previewOnly) return url;

  const pName = [val('po-firstName'),val('po-lastName')].filter(Boolean).join('_') || val('po-caseId') || 'PreOp';
  const a = document.createElement('a');
  a.href = url;
  a.download = 'AnesthesiaRecord_'+pName+'_'+surgDate.replace(/\//g,'-')+'.pdf';
  a.click();
};

window.previewAnesthesiaRecord = async function(record) {
  const old = document.getElementById('anes-preview-modal');
  if(old) old.remove();
  const loading = document.createElement('div');
  loading.id = 'anes-loading';
  loading.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;font-family:DM Sans,sans-serif';
  loading.textContent = 'Generating preview...';
  document.body.appendChild(loading);
  try {
    const blobUrl = await window.generateAnesthesiaRecord(record, true);
    loading.remove();
    const modal = document.createElement('div');
    modal.id = 'anes-preview-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:2147483647;display:flex;flex-direction:column;align-items:center;padding:20px;overflow-y:auto';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;width:100%;max-width:700px;box-shadow:0 20px 60px rgba(0,0,0,.5)';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'background:#1d3557;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center';
    hdr.innerHTML = '<span style="font-weight:600;font-size:15px">Anesthesia Record Preview</span>';
    const btns = document.createElement('div');
    btns.style.display = 'flex'; btns.style.gap = '10px';
    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download PDF';
    dlBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit';
    dlBtn.onclick = () => window.generateAnesthesiaRecord(record, false);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit';
    closeBtn.onclick = () => modal.remove();
    btns.appendChild(dlBtn); btns.appendChild(closeBtn);
    hdr.appendChild(btns);
    const iframe = document.createElement('iframe');
    iframe.src = blobUrl;
    iframe.style.cssText = 'width:100%;height:80vh;border:none;border-radius:0 0 10px 10px';
    box.appendChild(hdr); box.appendChild(iframe);
    modal.appendChild(box);
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  } catch(e) {
    document.getElementById('anes-loading')?.remove();
    alert('Error: '+e.message);
    console.error(e);
  }
};

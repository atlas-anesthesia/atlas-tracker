// ── anesthesia.js — Print Record PDF generator ──────────────────────────────
// Depends on: app.js (window.currentWorker)
// Requires: anesthesia-record.pdf in GitHub repo root


// ── ANESTHESIA RECORD PDF GENERATOR (overlays onto exact sheet) ───────────────
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
  const drawX = (tx, ty) => {
    page.drawText('X', { x: tx - 12, y: Y(ty) + 4, size: 7.5, font: fontBold, color: rgb(0,0,0) });
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
    const minY = maxY ? Y(maxY) + 2 : 0; // stop before this Y (pdf-lib coords)
    words.forEach(w => {
      if((line + ' ' + w).trim().length > maxChars) {
        if(cy > minY) {
          page.drawText(line.trim(), {x, y: cy, size: 6.5, font, color: rgb(0,0,0)});
        }
        cy -= lineH;
        line = w;
      } else {
        line = (line + ' ' + w).trim();
      }
    });
    if(line && cy > minY) {
      page.drawText(line.trim(), {x, y: cy, size: 6.5, font, color: rgb(0,0,0)});
    }
  };

  // ALLERGIES (box: y=37 to y=114 in pymupdf, content area y=44-110)
  drawWrap(val('po-allergies'), 32, 52, 75, 9, 110);

  // PUPIL EXAM y=133
  if(chk('po-pupil-normal'))      drawX(107, 133);
  if(chk('po-pupil-dilated'))     drawX(164, 133);
  if(chk('po-pupil-constricted')) drawX(223, 133);

  // CARDIOVASCULAR y=156
  if(chk('po-cv-neg'))     drawX(122, 156); if(chk('po-cv-htn'))    drawX(152, 156);
  if(chk('po-cv-cad'))     drawX(182, 156); if(chk('po-cv-angina')) drawX(211, 156);
  if(chk('po-cv-mi'))      drawX(253, 156); if(chk('po-cv-chf'))    drawX(276, 156);
  // row 2 y=171
  if(chk('po-cv-murmur'))    drawX(111, 171);
  if(chk('po-cv-arrythmia')) drawX(162, 171);
  drawT(val('po-cv-other'), 245, 171, 7);

  // EKG y=192
  if(chk('po-ekg-nsr'))   drawX(72,  192); if(chk('po-ekg-afib'))  drawX(103, 192);
  if(chk('po-ekg-bbb'))   drawX(135, 192); if(chk('po-ekg-lvh'))   drawX(166, 192);
  if(chk('po-ekg-chngs')) drawX(195, 192);

  // PULMONARY y=214
  if(chk('po-pulm-neg'))        drawX(102, 214); if(chk('po-pulm-asthma'))     drawX(135, 214);
  if(chk('po-pulm-copd'))       drawX(180, 214); if(chk('po-pulm-uri'))        drawX(215, 214);
  if(chk('po-pulm-o2cpap'))     drawX(241, 214);
  if(chk('po-pulm-sleepapnea')) drawX(101, 226);
  if(chk('po-pulm-blbs'))       drawX(165, 226);
  if(chk('po-pulm-smoker'))     drawX(252, 226);

  // GASTRO y=247
  if(chk('po-gi-neg'))      drawX(90,  247); if(chk('po-gi-gerd'))     drawX(123, 247);
  if(chk('po-gi-hiathern')) drawX(158, 247); if(chk('po-gi-ulcer'))    drawX(211, 247);

  // RENAL y=267
  if(chk('po-renal-neg'))      drawX(90,  267);
  if(chk('po-renal-dialysis')) drawX(122, 267);
  if(chk('po-renal-esrd'))     drawX(170, 267);

  // NEURO y=285
  if(chk('po-neuro-neg'))        drawX(91,  285);
  if(chk('po-neuro-depression')) drawX(123, 285);
  if(chk('po-neuro-anxiety'))    drawX(184, 285);
  if(chk('po-neuro-seizures'))   drawX(267, 285);
  if(chk('po-neuro-cva'))        drawX(91,  299);
  if(chk('po-neuro-nmdisease'))  drawX(122, 299);

  // METABOLIC y=319
  if(chk('po-met-neg'))     drawX(101, 319); if(chk('po-met-iddm'))    drawX(133, 319);
  if(chk('po-met-niddm'))   drawX(168, 319); if(chk('po-met-thyroid')) drawX(209, 319);
  if(chk('po-met-hep'))     drawX(258, 319);
  if(chk('po-met-obesity'))       drawX(101, 334);
  if(chk('po-met-morbidobesity')) drawX(149, 334);

  // TEETH y=352
  if(chk('po-teeth-intact'))  drawX(78,  352);
  if(chk('po-teeth-missing')) drawX(120, 352);
  if(chk('po-teeth-denture')) drawX(166, 352);

  // OTHER y=371
  if(chk('po-other-hiv'))       drawX(81,  371); if(chk('po-other-hepc'))     drawX(111, 371);
  if(chk('po-other-anemia'))    drawX(149, 371); if(chk('po-other-steroids'))  drawX(192, 371);
  if(chk('po-other-cancers'))   drawX(243, 371);
  if(chk('po-other-drugabuse')) drawX(82,  384);
  if(chk('po-other-coag'))      drawX(143, 384);
  if(chk('po-other-chemo'))     drawX(219, 384);

  // MEDICATIONS box: y=402 to y=449 → content: start y=412, stop before y=447
  drawWrap(val('po-medications'), 32, 412, 52, 8, 446);

  // SURGICAL HISTORY box: y=449 to y=477 → content: start y=460, stop before y=475
  drawWrap(val('po-surgicalHistory'), 32, 460, 52, 8, 474);

  // PHYSICAL ASSESSMENT
  drawT(val('po-assessTime'), 408, 477, 7.5);
  // VSS / A+0x3 / QUESTIONS ANSWERED — always mark when record is filled
  drawX(52, 491); drawX(86, 491); drawX(125, 491);

  drawT(val('po-heart-notes'), 115, 508, 7.5);
  drawT(val('po-lungs-notes'), 115, 522, 7.5);
  drawT(val('po-abd-notes'),   200, 537, 7.5);

  // MALLAMPATI
  const mp = val('mallampati');
  if(mp==='1') drawX(133, 552); if(mp==='2') drawX(149, 552);
  if(mp==='3') drawX(164, 552); if(mp==='4') drawX(179, 552);

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
  drawT(callFmt, 435, 96, 7.5);

  drawX(329, 126); // PRE-OP INSTRUCTIONS CONFIRMED
  if(chk('po-npo'))    drawX(356, 138);
  if(chk('po-driver')) drawX(356, 167);
  drawT(val('po-driverName'), 415, 180, 7.5);
  drawT(val('po-driverRel'),  415, 192, 7.5);
  if(chk('po-nodrive')) drawX(355, 205);

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

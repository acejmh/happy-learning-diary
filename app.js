const $=id=>document.getElementById(id);
let file=null, originalText='', currentText='', mission=0, corrections=[];
const fileInput=$('file'), drop=$('drop'), preview=$('preview'), readBtn=$('readBtn');
function accept(f){if(!f||!f.type.startsWith('image/'))return alert('이미지 파일만 올려 주세요.');file=f;preview.src=URL.createObjectURL(f);preview.style.display='block';readBtn.disabled=false;$('readStatus').textContent='사진이 준비됐어요.'}
fileInput.onchange=e=>accept(e.target.files[0]);
['dragenter','dragover'].forEach(x=>drop.addEventListener(x,e=>{e.preventDefault();drop.style.background='#eaf4ff'}));
['dragleave','drop'].forEach(x=>drop.addEventListener(x,e=>{e.preventDefault();drop.style.background=''}));
drop.addEventListener('drop',e=>accept(e.dataTransfer.files[0]));
readBtn.onclick=async()=>{readBtn.disabled=true;$('readStatus').textContent='사진의 글씨를 읽는 중이에요…';try{let fd=new FormData();fd.append('image',file);let r=await fetch('/.netlify/functions/analyze',{method:'POST',body:fd});let d=await r.json();if(!r.ok)throw Error(d.error||'인식 실패');originalText=d.text||'';$('sourceText').value=originalText;$('sourceText').disabled=false;$('confirmBtn').disabled=!originalText.trim();$('readStatus').textContent='인식이 끝났어요. 원본 글과 맞는지 확인해 주세요.'}catch(e){$('readStatus').textContent='인식에 실패했어요: '+e.message+' (API 키와 Functions 배포를 확인해 주세요.)';readBtn.disabled=false}};
$('confirmBtn').onclick=()=>{currentText=$('sourceText').value.trim();if(!currentText)return alert('글을 확인해 주세요.');startMission()};
function startMission(){mission=1;$('title').textContent='내가 쓴 글을 차근차근 고쳐 봐요.';$('status').textContent='정답을 직접 고친 뒤 다음으로 넘어가요.';renderMission()}
function renderMission(){ $('step').textContent=`${mission} / 3`; $('bar').style.width=(mission/3*100)+'%';let qs=[
['맞춤법 미션','문장에서 맞춤법이 어색한 부분을 찾아 바르게 고쳐 보세요.','예: 재미있었다 → 재미있었어요'],
['띄어쓰기 미션','붙어 있는 말을 알맞게 띄어 써 보세요.','예: 두개 → 두 개, 배운점 → 배운 점'],
['조사·문맥 미션','누가 무엇을 했는지 잘 드러나도록 조사와 문장 연결을 고쳐 보세요.','예: 나는 과학 실험 재미있었다 → 나는 과학 실험이 재미있었다.']];
$('app').innerHTML=`<div class="ocr"><b>현재 글</b><br>${escape(currentText)}</div><div class="mission"><h2>미션 ${mission} · ${qs[mission-1][0]}</h2><p>${qs[mission-1][1]}</p><div class="hint">${qs[mission-1][2]}</div><textarea id="answer" placeholder="고친 문장을 전체로 써 보세요.">${escape(currentText)}</textarea><button class="primary" id="check">답변 확인하기</button><div id="fb"></div></div>`;$('check').onclick=check}
async function check(){let a=$('answer').value.trim();if(a.length<5)return show('짧은 답변이에요. 문장 전체를 써 보세요.',false);try{let r=await fetch('/.netlify/functions/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'check',original:currentText,answer:a,mission})});let d=await r.json();if(d.pass){corrections.push(...(d.corrections||[]));currentText=d.corrected||a;if(mission<3){mission++;renderMission()}else finish()}else show(d.feedback||'문장의 뜻과 흐름을 다시 살펴보세요.',false)}catch(e){show('점검 서버에 연결할 수 없어요. Netlify Function 배포를 확인해 주세요.',false)}}
function show(t,ok){$('fb').innerHTML=`<div class="${ok?'feedback':'hint'}">${t}</div>`}
function finish(){ $('step').textContent='완료';$('bar').style.width='100%';$('title').textContent='점검이 끝났어요!';$('status').textContent='전·후 문장과 고친 이유를 확인해 보세요.';let before=escape(originalText), after=highlight(originalText,currentText);let list=corrections.length?corrections.map(c=>`<li><b>${escape(c.before)}</b> → <b>${escape(c.after)}</b><br>${escape(c.reason)}</li>`).join(''):'<li>고친 부분이 없어요. 맞춤법과 띄어쓰기가 자연스러워요.</li>';$('app').innerHTML=`<div class="mission"><h2>완료 🎉</h2><p>처음 쓴 글과 고친 글을 비교해 보세요.</p><div class="compare"><div><b>전</b><br>${before}</div><div><b>후</b><br>${after}</div></div><h3>무엇을 고쳤나요?</h3><ul>${list}</ul></div><button class="primary" onclick="location.reload()">새 글 점검하기</button>`}
function highlight(a,b){let x=escape(b);return x.replace(/([가-힣A-Za-z0-9]{1,12})/g,m=>b!==a&&a.indexOf(m)<0?`<span class="highlight">${m}</span>`:m)}
function escape(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

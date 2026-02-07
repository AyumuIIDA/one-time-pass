const express = require('express');
const app = express();
const {google} = require("googleapis");
const MailComposer = require("mailcomposer").MailComposer;

const  {Firestore} = require("@google-cloud/firestore");
const firestore = new Firestore({
  projectId: process.env.PROJECT_NAME,
});
const stateRef = firestore.collection("state").doc("gmail");

// async function getLastHistoryId(){
//   const doc = await stateRef.get();
//   if(!doc.exist) return null;
//   return doc.data().lastHistoryId;
// }

async function getLastHistoryId() {
  try {
    const snap = await stateRef.get();

    if (!snap.exists) return null;

    const data = snap.data();
    console.log("[FS GET] lastHistoryId raw =", data?.lastHistoryId);
    return data?.lastHistoryId ? String(data.lastHistoryId) : null;

  } catch (e) {
    console.error("[FS GET] FAILED", e?.code, e?.message);
    throw e; 
  }
}

async function setLastHistoryId(historyId){
  await stateRef.set({
    lastHistoryId: historyId,
    updateAt: new Date(),
  });
}
 
app.use(express.json({type: '*/*'}));

// ############## env ################
const {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REFRESH_TOKEN,
  FROM_EMAIL,
  TARGET_EMAIL,
  TO_MAIL,
  CHECKED_LABEL_NAME = "CHECKED",
} = process.env;
// ###################################


// pub/sub のmessage.dataをdecodeしてjson形式で返す
function decodePubSubMessage(body) {
    if(!body || !body.message || !body.message.data) return null;
    const jsonStr = Buffer.from(body.message.data, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
}

function getGmailClient(){
    // 自分のgmailにアクセス
    const oauth2 = new google.auth.OAuth2(OAUTH_CLIENT_ID,OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({
        refresh_token: OAUTH_REFRESH_TOKEN,
    });
    return google.gmail({version:"v1",auth: oauth2});
}

async function ensureLabel(gmail) {
    // gmail内のCHECKED_LABEL_NAMEのidを取得する
    const res = await gmail.users.labels.list({userId: "me"});
    const found = (res.data.labels || []).find((l) => l.name === CHECKED_LABEL_NAME);
    if(found) return found.id;

    const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
            name: CHECKED_LABEL_NAME,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
        },
    });
    return created.data.id;
}

function header(headers, name){
    const h = (headers || []).find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
    return h?.value || "";
}

function extractEmailAdress(fromHeader){
    const m = (fromHeader || "").match(/<([^>]+)>/);
    const addr = ((m ? m[1] : fromHeader) || "").trim();
    return addr.toLowerCase();
}

function decodeBase64Url(data){
    if(!data) return null;
    const b64 = data.replace(/-/g,"+").replace(/_/g,"/");
    return Buffer.from(b64,"base64").toString();
}

function findPartByMime(payload, mimeType){
    // payloadから本文を抜き出す
    if(!payload) return null;
    if(payload.mimeType === mimeType && payload.body?.data) return payload;
    const parts = payload.parts || [];
    for(const p of parts){
        const found = findPartByMime(p, mimeType);
        if(found) return found;
    }
    return null;
}

function extractMessageText(payload){
    // text plain を探す
    const plain = findPartByMime(payload, "text/plain");
    if(plain) return decodeBase64Url(plain.body.data);
    
    // html を探す
    const html = findPartByMime(payload, "text/html");
    if(html) return decodeBase64Url(html.body.data);

    return null;
}

function shouldCheck({from, subject, autoSubmitted, preceedence, listId}) {
    // 目的のメールかどうかを判定
    if(!from || !subject) return false;
    // 自分からのメールには返信しない
    if(FROM_EMAIL && from.toLowerCase().includes(FROM_EMAIL.toLowerCase())) return false;
    if((autoSubmitted || "").toLowerCase() && autoSubmitted.toLowerCase() !== "no") return false;
    const p = (preceedence || "").toLowerCase();
    if(p.includes("bulk") || p.includes("list")) return false;
    if(listId) return false;
    if(/no-reply/i.test(from)) return false;

    // target addressのみ通す
    const fromAddr = extractEmailAdress(from);
    if(TARGET_EMAIL && fromAddr !== TARGET_EMAIL.toLowerCase()) return false;

    return true;
}

function extractPasscode(text){
  let m = text.match(/【ワンタイムパスワード】(\d+)/);
  return m[1];
}

async function buildForwardRaw({to, subject ,text}) {
  const mail = new MailComposer({
      to,
      from: FROM_EMAIL,
      subject: `${subject}`,
      text: extractPasscode(text),
  });
  const message = await new Promise((resolve, reject) => {
      mail.compile().build((err,msg)=>(err ? reject(err) : resolve(msg)));
  });

  return Buffer.from(message).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

async function handleGmailNotification(notif) {
  const gmail = getGmailClient();
  const checkedLabelId = await ensureLabel(gmail);

  const historyId = String(notif.historyId);
  const lockRef = firestore.collection("locks").doc(historyId);

  // lock処理。ほぼ同時にリクエストされた場合に同じIDを繰り返し読まない。
  const alreadyProvessing = await firestore.runTransaction(async (t)=>{
    const lockDoc = await t.get(lockRef);
    if(lockDoc.exists){
      // すでに処理済み
      return true;
    }

    t.set(lockRef,{
      historyId: historyId,
      createdAt: new Date(),
    });
    // 新しく読むべきID
    return false;
  });

  // 処理済みは終了
  if(alreadyProvessing) return;

  let lastHistoryId = await getLastHistoryId();   
  // 初回起動。現在のhystoryIdを記録して終了
  if(!lastHistoryId){
    await setLastHistoryId(notif.historyId);
    console.log("Initialized lastHistoryId:",notif.historyId);
    return;
  }

  //前回からの差分を取得
  const hist = await gmail.users.history.list({
    userId: "me",
    startHistoryId: lastHistoryId,
    historyTypes: ["messageAdded"],
    maxResults:10,
  });

  // 追加されたメールのidを取得
  const historyItems = hist.data.history || [];
  const messageIds = new Set();
  for(const h of historyItems){
      for(const a of h.messagesAdded || []){
          if(a?.message?.id) messageIds.add(a.message.id);
      }
  }

  console.log("messageIds to inspect:",[...messageIds]);

  for (const id of messageIds) {

    let msg;
    msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });


    const headers = msg.data.payload?.headers || [];
    const from = header(headers, "From");
    const subject = header(headers, "Subject");
    const ok = shouldCheck({
      from,
      subject,
      autoSubmitted: header(headers, "Auto-Submitted"),
      precedence: header(headers, "Precedence"),
      listId: header(headers, "List-Id"),
    });
    if (!ok) {
      console.log("%c========== Not Elidgeble ==========",'color:green,font-weight:bold')
      continue;
    }

    const fullText = extractMessageText(msg.data.payload);
    const to = process.env.FORWARD_TO_EMAIL;
    
    let raw;
    raw = await buildForwardRaw({
      to:TO_MAIL,
      subject,
      text: fullText,
    });

    
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    console.log("%c========== Message Send ==========",'color:green,font-weight:bold');

    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: { addLabelIds: [checkedLabelId] },
    });
  }

  await setLastHistoryId(notif.historyId);

}

// pub/subからのpushを受信する
app.post("/", async (req,res)=>{
    try{
        //pub/subの生データ
        console.log("%c========== Pub/Sub push recieved ==========",'color:green,font-weight:bold');
        console.log("From : ",req.headers.from);
        // console.log("Body : ",req.body);

        // 復号
        const notif = decodePubSubMessage(req.body);
        console.log("Decoded notif : ", notif);

        // 通知にhistoryID が含まれるか確認
        if(!notif?.historyId) return res.status(204).send("");

        await handleGmailNotification(notif);
        return res.status(204).send("");
    }catch(err){
        console.error(err);
        return res.status(204).send("Internal Server Error");
    }
});

// portは環境変数で指定
const port = process.env.PORT || 8080;
app.listen(port, ()=> console.log(`Listening on port ${port}`));


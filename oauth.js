const http = require("http");
const {URL} = require("url");
const {google} = require("googleapis");
const { asyncWrapProviders } = require("async_hooks");

// Google API の認証を得るためのファイル

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

// refresh token を得られれば良いのでlocalにリダイレクト
const REDIRECT_URI = "https://3000-cs-a43b4bd5-2b1c-4803-a3e6-ff7aeec29707.cs-asia-east1-jnrc.cloudshell.dev/oauth2callback";

if(!CLIENT_ID || !CLIENT_SECRET){
    console.error("Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET");
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID,CLIENT_SECRET,REDIRECT_URI);

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
});

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting callback at http://localhost:3000/oauth2callback\n");

http.createServer(async (req,res)=>{
    try{
        const url = new URL(req.url,REDIRECT_URI);
        if(url.pathname !== "/oauth2callback"){
            res.end("Not Found");
            return;
        }
        const code = url.searchParams.get("code");
        if(!code){
            res.end("No code");
            return;
        }

        const {tokens} = await oauth2Client.getToken(code);
        console.log("\n ========= TOKENS =========\n",tokens);
        console.log("\nSave refresh token security\n");

        res.end("Authorization completed. You can close this window");
        process.exit(0);
    }catch (error){
        console.error(error);
        res.statusCode(500);
        res.end("Error");
        process.exit(1);
    }
}).listen(3000);
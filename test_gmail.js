const {google} = require("googleapis");

const oauth2 = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
);

oauth2.setCredentials({
    refresh_token: process.env.OAUTH_REFRESH_TOKEN,
});

const gmail = google.gmail({
    version: "v1",
    auth: oauth2,
});

(async ()=>{
    const profile = await gmail.users.getProfile({userId: "me"});
    console.log("Gmail profile:",profile.data);
})();
// gmailの通知をプロジェクトのトピックスに接続するためのファイル

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
    const topicName = `projects/${process.env.PROJECT_NAME}/topics/gmail-notify`;

    const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
            topicName,
            labelIds: ["INBOX"],
            labelFilterAction: "include",
        },
    });
    
    console.log("watch response:", res.data);
})();

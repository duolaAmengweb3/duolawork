// The provider calls this helper instead of opening windows from the background.
// Only the official sign-in URL is surfaced in the owner's Hub connection panel.
const value=process.argv[2];
try{const url=new URL(value);if(url.origin==='https://accounts.google.com'&&url.pathname==='/o/oauth2/v2/auth')process.stderr.write('HUB_GOOGLE_AUTH '+url.href+'\n');}catch{}

git pull
cmd.exe /c npm install
cmd.exe /c npm run build
node ./out/index.js %*

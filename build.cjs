const fs = require("fs");
const template = fs.readFileSync("index.template.html", "utf8");
const js = fs.readFileSync("app.js", "utf8");
fs.writeFileSync("index.html", `${template}<script src="config.js"></script>\n<script>\n${js}\n</script>\n</body>\n</html>\n`);
console.log("index.html rebuilt:", fs.statSync("index.html").size, "bytes");

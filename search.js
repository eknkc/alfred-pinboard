var lockfile = require('lockfile');
var spawn = require("child_process").spawn;
var async = require('async');
var request = require('request');
var fs = require('fs');
var natural = require('natural');
natural.PorterStemmer.attach();
var mkdirp = require('mkdirp');
var path = require('path');
var xml = require("xml-writer");
var out = new xml(false, function (str, encoding) {
  process.stdout.write(str, encoding);
});

var arg = process.argv[2];

async.auto({
  configFile: function (next) {
    var filename = path.join(process.env.HOME, "/Library/Application Support/Alfred 2/Workflow Data/eknkc.pinboard/config.json");
    mkdirp(path.dirname(filename), function (err) {
      if (err) return next(err);
      next(null, filename);
    });
  },
  cacheFile: function(next) {
    var filename = path.join(process.env.HOME, "/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow Data/eknkc.pinboard/bookmarks.json");
    mkdirp(path.dirname(filename), function (err) {
      if (err) return next(err);
      next(null, filename);
    });
  },
  config: ["configFile", function (next, data) {
    fs.exists(data.configFile, function (exists) {
      if (!exists)
        return process.nextTick(function() { next(null, {}); });

      fs.readFile(data.configFile, "utf8", function (err, filedata) {
        if (err) return next(err);
        next(null, JSON.parse(filedata));
      });
    })
  }],
  cache: ["cacheFile", function (next, data) {
    fs.exists(data.cacheFile, function (exists) {
      if (!exists)
        return process.nextTick(function() { next(null, {}); });

      fs.readFile(data.cacheFile, function (err, data) {
        if (err) return next(err);
        next(null, JSON.parse(data));
      });
    })
  }],
  checkAuth: ["config", "cache", function (next, data) {
    if (arg == "--pbtoken" && /^[^:]+:[0-9A-Z]+$/.test((process.argv[3] || "").trim())) {
      data.config.token = process.argv[3].trim();
      data.config.dirty = true;

      data.cache = {
        dirty: true
      };

      return process.nextTick(function() { next(null, "new"); });
    }

    if (!data.config.token)
      return process.nextTick(function() { next(new Error("NoAuthentication")); });

    return process.nextTick(function() { next(null, true); });
  }],
  checkReindex: ["cache", function (next, data) {
    if (arg != '--reindex')
      return process.nextTick(next);

    arg = "";
    data.cache = {
      dirty: true
    };

    return process.nextTick(next);
  }],
  search: ["checkAuth", "checkReindex", function (next, data) {
    if (!data.cache.entries) {
      return reload(function (err) {
        if (err) return next(err);
        search(next);
      });
    }

    search(next);

    function search(next) {
      var keywords = arg.tokenizeAndStem().map(function (kw) {
        return new RegExp(kw.replace(/(?=[\\^$*+?.()|{}[\]])/g, "\\"), "gi");
      });

      if (!keywords.length)
        return process.nextTick(function() { next(null, []); });

      var results = data.cache.entries
      .map(function (entry) {
        var matches = 1;
        keywords.forEach(function (kw) {
          matches *= entry.keywords.filter(function (ekw) {
            return kw.test(ekw);
          }).length;
        });
        return {
          entry: entry,
          matches: matches
        }
      })
      .filter(function (data) {
        return data.matches;
      });

      results.sort(function (a, b) {
        return b.matches - a.matches;
      });

      next(null, results.slice(0, 8));
    }

    function reload(next) {
      request({
        method: "GET",
        url: "https://api.pinboard.in/v1/posts/all",
        qs: { auth_token: data.config.token, format: "json" }
      }, function (err, res, body) {
        if (err) return next(err);
        if (res.statusCode == 401) return next(new Error("NoAuthentication"));
        if (res.statusCode != 200) return next(new Error("UnknownError"));

        data.cache = {
          entries: JSON.parse(body),
          dirty: true,
          date: Date.now()
        };

        data.cache.entries.forEach(function (data) {
          data.keywords = [data.description, data.extended, data.tags].join(" ").tokenizeAndStem();
        });

        next();
      });
    }
  }]
}, function (err, data) {
  if (!data.cache.date || data.cache.date < (Date.now() - 1000 * 60 * 10)) {
    data.spawn = true;
    data.cache.date = Date.now();
    data.cache.dirty = true;
  }

  if (data.config.dirty) {
    delete data.config.dirty;
    fs.writeFileSync(data.configFile, JSON.stringify(data.config), "utf8");
  }

  if (data.cache.dirty) {
    delete data.cache.dirty;
    fs.writeFileSync(data.cacheFile, JSON.stringify(data.cache), "utf8");
  }

  if (err && ["NoAuthentication"].indexOf(err.message) < 0) {
    console.error(err.message);
    process.exit(-1)
  }

  out.startDocument();
  out.startElement("items");

  if (err && err.message == "NoAuthentication") {
    out.startElement("item")
      .writeAttribute('uid', "notoken")
      .writeElement('icon', "icon.png")
      .writeElement("title", "Please set your authentication token")
      .writeElement("subtitle", "You can use <pinboardauth TOKEN> to set your auth token.");
    out.endElement();
  } else {
    data.search.forEach(function (data) {
      var entry = data.entry;

      out.startElement("item")
        .writeAttribute('uid', entry.hash)
        .writeAttribute('arg', entry.href)
        .writeElement('icon', "icon.png")
        .writeElement("title", entry.description)
        .writeElement("subtitle", entry.extended || entry.href);
      out.endElement();
    });
  }

  out.endElement("items");
  out.endDocument();

  if (data.spawn) {
    spawn(process.execPath, [__filename, "--reindex"], { detached: true, stdio: "ignore" });
  }

  process.exit(0);
});


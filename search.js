var spawn = require("child_process").spawn;
var argv = require('optimist').argv;
argv.q = argv.q || "";
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
    if (argv.pbtoken && /^[^:]+:[0-9A-Z]+$/.test(argv.pbtoken)) {
      data.config.token = argv.pbtoken;
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
  ensureData: ["checkAuth", "cache", function (next, data) {
    if (argv.reindex) {
      data.cache = { dirty: true };
    }

    if (data.cache && data.cache.entries)
      return process.nextTick(next);

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
  }],
  search: ["ensureData", function (next, data) {
    var keywords = argv.q.tokenizeAndStem().map(function (kw) {
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
  }],
  unread: ["ensureData", function(next, data) {
    if (!argv.toread)
      return process.nextTick(function() { next(null, []); });

    var results = data.cache.entries
    .filter(function (data) {
      return data.toread == "yes";
    });

    results.sort(function (a, b) {
      return b.date - a.date;
    });

    next(null, results.slice(0, 8).map(function (data) {
      return {
        entry: data
      }
    }));
  }],
  results: ["unread", "search", function (next, data) {
    return process.nextTick(function() { next(null, data.unread.concat(data.search)); });
  }]
}, function (err, data) {
  if (!data.checkReindex && data.cache && data.cache.date && data.cache.date < (Date.now() - 1000 * 60 * 10)) {
    data.spawn = true;
    data.cache = data.cache || {};
    data.cache.date = Date.now();
    data.cache.dirty = true;
  }

  if (data.config && data.configFile && data.config.dirty) {
    delete data.config.dirty;
    fs.writeFileSync(data.configFile, JSON.stringify(data.config), "utf8");
  }

  if (data.cache && data.cacheFile && data.cache.dirty) {
    delete data.cache.dirty;
    fs.writeFileSync(data.cacheFile, JSON.stringify(data.cache), "utf8");
  }

  out.startDocument();
  out.startElement("items");

  if (err && err.message == "NoAuthentication") {
    out.startElement("item")
      .writeAttribute('uid', "notoken")
      .writeAttribute('valid', "no")
      .writeElement('icon', "icon.png")
      .writeElement("title", "Please set your authentication token")
      .writeElement("subtitle", "You can use <pinboardauth TOKEN> to set your auth token.");
    out.endElement();
  } else if (err) {
    out.startElement("item")
      .writeAttribute('uid', "error")
      .writeAttribute('valid', "no")
      .writeElement('icon', "icon.png")
      .writeElement("title", "Pinboard Search Error:")
      .writeElement("subtitle", err.message);
    out.endElement();
  } else if (!data.results || !data.results.length) {
    out.startElement("item")
      .writeAttribute('uid', "noresults");

    if (!argv.toread)
      out.writeAttribute('arg', "https://pinboard.in/search/?query=" + encodeURIComponent(argv.q));
    else
      out.writeAttribute('valid', "no");

    out.writeElement('icon', "icon.png")
      .writeElement("title", "No Results");

    if (!argv.toread)
      out.writeElement("subtitle", "No bookmarks found. Search Pinboard wesite for: " + argv.q);
    else
      out.writeElement("subtitle", "You have no unread bookmarks.");

    out.endElement();
  } else {
    data.results.forEach(function (data) {
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
    console.log("REINDEX")
    spawn(process.execPath, [__filename, "--reindex"], { detached: true, stdio: "ignore" });
  }

  process.exit(0);
});


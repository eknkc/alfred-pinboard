var argv = require('optimist').argv;
var async = require('async');
var request = require('request');
var fs = require('fs');
var mkdirp = require('mkdirp');
var path = require('path');

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
  remove: ["config", "cacheFile", function (next, data) {
    request({
      method: "GET",
      url: "https://api.pinboard.in/v1/posts/delete",
      qs: { auth_token: data.config.token, format: "json", url: argv.url }
    }, function (err, res, body) {
      if (err) return next(err);
      if (res.statusCode == 401) return next(new Error("NoAuthentication"));
      if (res.statusCode != 200) return next(new Error("UnknownError"));

      fs.unlink(data.cacheFile, next);
    });
  }]
}, function (err, data) {
  if (err)
    return console.log("Unable to delete bookmark.");

  console.log("Bookmark Deleted.");

  process.exit(0);
});


var http = require('http');
var Promise = require('bluebird');
var anitag = require('./anitag');

var PROPS_TAG = ['links'];
var PROPS_LINK = ['meta', 'tags', 'tagmeta'];
var DB_NUM = 3;

var DB = function(redis)
{
    var self = this;
    self.redisClient = redis;
    var readyPromise = self.redisClient.selectAsync(parseInt(DB_NUM));

    self.Ready = function()
    {
        return readyPromise;
    };
};

DB.prototype.DeleteLink = function(link)
{
    var self = this;
    // Remove link from tags
    return self.Ready()
        .then(function()
        {
            return self.redisClient.smembersAsync('link:[' + link + ']:tags');
        })
        .then(function(tags)
        {
            return Promise.map(tags, function(tag)
            {
                return self.redisClient.sremAsync('tag:[' + tag + ']:links', link);
            });
        })
        .then(function()
        {
            var promises = [];
            PROPS_LINK.forEach(function(p)
            {
                promises.push(self.redisClient.delAsync('link:[' + link + ']:' + p));
            });
            promises.push(self.redisClient.sremAsync('tag:[all]:links', link));
            return Promise.all(promises);
        });
};

DB.prototype.AddLink = function(url, tagBlob, tagAlg, src, srcLink, updated)
{
    // @TODO handle reposts better
    var self = this;
    return self.Ready()
        .then(function()
        {
            var promises = [];
            var tags = anitag.TagScan(tagAlg, tagBlob);
            promises.push(self.redisClient.saddAsync('tag:[all]:links', url));
            promises.push(self.redisClient.hmsetAsync('link:[' + url + ']:meta', 'src', src, 'origin', srcLink, 'updated', updated));
            promises.push(self.redisClient.hmsetAsync('link:[' + url + ']:tagmeta', 'blob', tagBlob, 'alg', tagAlg));
            if (tags.length == 0)
            {
                tags.push('untagged');
            }
            promises.push(self.redisClient.saddAsync('link:[' + url + ']:tags', tags));
            for (var k in tags)
            {
                promises.push(self.redisClient.saddAsync('tags', tags[k]));
                promises.push(self.redisClient.saddAsync('tag:[' + tags[k] + ']:links', url));
            }
            return Promise.all(promises).catch(console.log);
        });
};

DB.prototype.GetLinks = function(tags, pStart, pLen)
{
    var self = this;
    var tagCombinedKey = 'mtag:[' + tags.join('+') + ']:links';
    var metaProps = ['src', 'origin', 'updated', '#'];
    var nameMap = {'#': 'url'};
    var tagKeys = tags.map(function(t)
    {
        return 'tag:[' + t + ']:links';
    });
    return self.Ready()
        .then(function()
        {
            if (tags.length > 1)
            {
                return self.redisClient.sunionstoreAsync(tagCombinedKey, tagKeys);
            }
            else
            {
                tagCombinedKey = 'tag:[' + tags[0] + ']:links';
                return Promise.resolve(true);
            }
        })
        .then(function()
        {
            var getList = metaProps.map(function(p)
                {
                    if (p == '#')
                    {
                        return ['GET', p];
                    }
                    else
                    {
                        return ['GET', 'link:[*]:meta->' + p];
                    }
                })
                .reduce(function(p, c)
                {
                    return p.concat(c);
                });
            var limList = ['LIMIT', parseInt(pStart), parseInt(pLen)];
            if (pLen <= 0 || pStart < 0 || pLen == null || pStart == null)
            {
                limList = [];
            }
            return self.redisClient.sortAsync([tagCombinedKey, 'BY', 'link:[*]:meta->updated'].concat(limList).concat(['DESC']).concat(getList));
        })
        .then(function(res)
        {
            res = res.reduce(function(p, c, i)
            {
                var r;
                var k = metaProps[i % metaProps.length];
                if (i % metaProps.length == 0)
                {
                    r = {};
                    p.push(r);
                }
                else
                {
                    r = p[p.length - 1];
                }
                if (nameMap.hasOwnProperty(k))
                {
                    k = nameMap[k];
                }
                r[k] = c;
                return p;
            }, []);
            return Promise.resolve(res);
        });
};

DB.prototype.DeleteTags = function(taglist)
{
    var self = this;
    return self.Ready()
        .then(function()
        {
            return self.redisClient.sremAsync('tags', taglist);
        })
        .then(function()
        {
            return self.GetLinks(taglist);
        })
        .then(function(links)
        {
            return Promise.props({
                delRes: Promise.map(links, function(v)
                {
                    return self.redisClient.sremAsync('link:[' + v.url + ']:tags', taglist);
                }),
                links: links
            });
        })
        .then(function(r)
        {
            var links = r.links;
            return Promise.map(links, function(v)
            {
                return Promise.props({tagCount: self.redisClient.scardAsync('link:[' + v.url + ']:tags'), url: v.url});
            });
        })
        .then(function(results)
        {
            var promises = [];
            results.forEach(function(r)
            {
                if (r.tagCount == 0)
                {
                    promises.push(self.redisClient.saddAsync('link:[' + r.url + ']:tags', 'untagged'));
                    promises.push(self.redisClient.saddAsync('tag:[untagged]:links', r.url));
                }
            });
            return Promise.all(promises);
        })
        .then(function()
        {
            var tagKeys = taglist.reduce(function(p, c)
            {
                return p.concat(PROPS_TAG.map(function(prop)
                {
                    return 'tag:[' + c + ']:' + prop;
                }));
            }, []);
            return self.redisClient.delAsync(tagKeys);
        })
};

DB.prototype.MergeTags = function(tag, taglist)
{
    var self = this;
    if (taglist.indexOf(tag) != -1)
    {
        taglist.splice(taglist.indexOf(tag), 1);
    }
    return self.Ready()
        .then(function()
        {
            return Promise.all(PROPS_TAG.map(function(p)
            {
                var taglistKeys = [tag].concat(taglist).map(function(t)
                {
                    return 'tag:[' + t + ']:' + p;
                });
                return self.redisClient.sunionstoreAsync(taglistKeys[0], taglistKeys);
            }));
        })
        .then(function()
        {
            return self.DeleteTags(taglist);
        })
};

module.exports = DB;
var http = require('http');
var Promise = require('bluebird');
var anitag = require('./anitag');

var PROPS_TAG = ['links'];
var PROPS_LINK = ['meta', 'tags', 'tagmeta'];
var DB_NUM = 3;

function GetSortResultReduce(props)
{
    return function(p, c, i)
    {
        var r;
        var k = props[i % props.length];
        if (i % props.length == 0)
        {
            r = {};
            p.push(r);
        }
        else
        {
            r = p[p.length - 1];
        }
        r[k] = c;
        return p;
    };
}

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
    return new Promise(function(resolve, reject)
    {
        self.Ready()
            .then(function()
            {
                return self.redisClient.smembersAsync('link:[' + link + ']:tags');
            })
            .then(function(tags)
            {
                return Promise.props({
                    tags: tags,
                    res: Promise.map(tags, function(tag)
                    {
                        return self.redisClient.sremAsync('tag:[' + tag + ']:links', link);
                    })
                });
            })
            .then(function(r)
            {
                return self.DeleteEmptyTags(r.tags);
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
            })
            .then(function()
            {
                resolve(true);
            });
    });
};

DB.prototype.AddLink = function(url, tagBlob, tagAlg, flags, src, srcLink, updated)
{
    // @TODO handle reposts better
    var self = this;
    return self.Ready()
        .then(function()
        {
            return anitag.TagScan(tagAlg, tagBlob);
        })
        .then(function(tags)
        {
            var promises = [];
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
            for (var i in flags)
            {
                promises.push(self.redisClient.saddAsync('flag:[' + flags[i] + ']:links', url));
            }
            return Promise.all(promises).catch(console.log);
        });
};

DB.prototype.UpdateTags = function()
{
    var self = this;
    var props = ['blob', 'alg', 'link'];
    var links;
    return self.Ready()
        .then(function()
        {
            return self.redisClient.smembersAsync('tags');
        })
        .then(function(tags)
        {
            if (tags.length > 0)
            {
                return self.DeleteTags(tags);
            }
            else
            {
                return Promise.resolve(true);
            }
        })
        .then(function()
        {
            return self.redisClient.sortAsync(['tag:[all]:links', 'BY', 'nosort', 'GET', 'link:[*]:tagmeta->blob', 'GET', 'link:[*]:tagmeta->alg', 'GET', '#']);
        })
        .then(function(res)
        {
            var promises = [];
            var alltags = {};
            res = res.reduce(GetSortResultReduce(props), []);
            links = res.map(function(r)
            {
                return r.link;
            });
            return Promise.props({
                promises: promises,
                alltags: alltags,
                links: links,
                result: Promise.map(res, function(r)
                {
                    return anitag.TagScan(r.alg, r.blob).then(function(tags)
                    {
                        if (tags.length == 0)
                        {
                            tags.push('untagged');
                        }
                        promises.push(self.redisClient.multi().del('link:[' + r.link + ']:tags').sadd(['link:[' + r.link + ']:tags'].concat(tags)).execAsync());
                        tags.forEach(function(t)
                        {
                            if (alltags[t] == null)
                            {
                                alltags[t] = [];
                            }
                            alltags[t].push(r.link);
                        });
                    });
                })
            });
        })
        .then(function(r)
        {
            var promises = r.promises;
            var alltags = r.alltags;
            promises.push(self.redisClient.saddAsync(['tags'].concat(Object.keys(alltags))));
            Object.keys(alltags).forEach(function(t)
            {
                promises.push(self.redisClient.saddAsync(['tag:[' + t + ']:links'].concat(alltags[t])));
            });
            return Promise.props({links: r.links, res: Promise.all(promises)});
        })
        .then(function(r)
        {
            return self.AddUntagged(r.links);
        });
};

DB.prototype.GetLinks = function(tags, flags, pStart, pLen)
{
    if (flags == null)
    {
        flags = [];
    }
    var self = this;
    var tagCombinedKey = 'mtag:[' + tags.join('+') + ']:flags[' + flags.join('+') + ']:links';
    var metaProps = ['src', 'origin', 'updated'];
    var linkProps = metaProps.concat(['url']);
    var tagKeys = tags.map(function(t)
    {
        return 'tag:[' + t + ']:links';
    });
    var flagKeys = flags.map(function(f)
    {
        if (f.length > 0 && f[0] == "-")
        {
            return "flag:[" + f.substring(1) + "]:links";
        }
    }).filter(function(f)
    {
        return f != null;
    });
    return self.Ready()
        .then(function()
        {
            if (tagKeys.length > 1 || flagKeys.length > 0)
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
            if (flagKeys.length > 0)
            {
                return self.redisClient.sdiffstoreAsync(tagCombinedKey, [tagCombinedKey].concat(flagKeys));
            }
            else
            {
                return Promise.resolve(true);
            }
        })
        .then(function()
        {
            var getList = metaProps.map(function(p)
                {
                    return ['GET', 'link:[*]:meta->' + p];
                })
                .reduce(function(p, c)
                {
                    return p.concat(c);
                });
            getList = getList.concat(['GET', '#']);
            var limList = ['LIMIT', parseInt(pStart), parseInt(pLen)];
            if (pLen <= 0 || pStart < 0 || pLen == null || pStart == null)
            {
                limList = [];
            }
            return self.redisClient.sortAsync([tagCombinedKey, 'BY', 'link:[*]:meta->updated'].concat(limList).concat(['DESC']).concat(getList));
        })
        .then(function(res)
        {
            res = res.reduce(GetSortResultReduce(linkProps), []);
            return Promise.resolve(res);
        })
        .then(function(res)
        {
            var tags = Promise.map(res, function(r)
            {
                return self.redisClient.smembersAsync('link:[' + r.url + ']:tags');
            });
            return Promise.join(res, tags, function(r, t)
            {
                return r.map(function(row, i)
                {
                    row['tags'] = t[i];
                    return row;
                });
            });
        });
};

DB.prototype.AddUntagged = function(links)
{
    var self = this;
    return self.Ready()
        .then(function()
        {
            return Promise.map(links, function(url)
            {
                return Promise.props({tagCount: self.redisClient.scardAsync('link:[' + url + ']:tags'), url: url});
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
        });
};

DB.prototype.GetTags = function()
{
    var self = this;
    return self.Ready()
        .then(function()
        {
            return self.redisClient.smembersAsync('tags');
        })
        .then(function(tags)
        {
            return Promise.map(tags, function(t)
            {
                return Promise.props({name: t, count: self.redisClient.scardAsync('tag:[' + t + ']:links')});
            })
        });
};

DB.prototype.DeleteTags = function(taglist)
{
    if (taglist.indexOf('all') != -1)
    {
        taglist.splice(taglist.indexOf('all'), 1);
    }
    if (taglist.length == 0)
    {
        return Promise.resolve(true);
    }
    var self = this;
    return self.Ready()
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
                })
            });
        })
        .then(function()
        {
            return self.redisClient.sremAsync('tags', taglist);
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
    var links;
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
            return self.redisClient.smembersAsync('tag:[' + tag + ']:links');
        })
        .then(function(l)
        {
            links = l;
            return Promise.map(links, function(l)
            {
                return Promise.props({link: l, res: self.redisClient.saddAsync('link:[' + l + ']:tags', tag)});
            });
        })
        .then(function(r)
        {
            return self.DeleteTags(taglist);
        })
        .then(function()
        {
            return self.AddUntagged(links);
        })
};

DB.prototype.DeleteEmptyTags = function(tags)
{
    var self = this;
    return self.Ready()
        .then(function()
        {
            return Promise.map(tags, function(t)
            {
                return Promise.props({name: t, len: self.redisClient.scardAsync('tag:[' + t + ']:links')});
            });
        })
        .then(function(tags)
        {
            var emptyTags = tags.filter(function(t)
            {
                return t.len == 0;
            });
            var rmTagPromise = Promise.map(emptyTags, function(t)
            {
                return Promise.all([
                    self.redisClient.srem('tags', t.name),
                    Promise.map(PROPS_TAG, function(p)
                    {
                        return self.redisClient.delAsync('tag:[' + t.name + ']:' + p);
                    })]);
            });
        })
};

module.exports = DB;
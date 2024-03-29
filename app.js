var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var exphbs = require('express-handlebars');

var main = require('./routes/index');
var tags = require('./routes/tags.js');

var app = express();

// view engine setup
app.engine('html', exphbs({
    extname: '.html',
    layoutsDir: "views/",
    partialsDir: "views/",
    defaultLayout: 'layout.html',
    helpers: require('./handlebar_helper')
}));
app.set('view engine', 'html');

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
//app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.use('/', main);
app.use('/', tags);

// catch 404 and forward to error handler

app.use(function(req, res, next)
{
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});


// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development')
{
    app.use(function(err, req, res, next)
    {
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        console.log("Error: " + (new Date()).toString() + ": " + ip + " (" + err.message + ")");
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
/*
 app.use(function(err, req, res, next) {
 res.status(err.status || 500);
 res.render('error', {
 message: err.message,
 error: {}
 });
 });
 */

app.listen(3001, '127.0.0.1', function()
{
    console.log("server started...");
});

module.exports = app;

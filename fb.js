// import express from "express";
// import puppeteer from "puppeteer";

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

let browser = null;
let page = null;

app.listen(1289, async () => {
    console.log('running');
})

app.get('/', async (req, res) => {
    browser = await puppeteer.launch();
    page = await browser.newPage();
    await page.goto('https://business.facebook.com/business/loginpage/');
    await page.waitForNetworkIdle();
    await page.screenshot({
        path: "fb2.png"
    })
    res.send({
        message: "ok"
    });
})
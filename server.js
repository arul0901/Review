require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/submit-review", async (req, res) => {

    console.log(req.body);

    res.json({
        success: true
    });
});

app.listen(process.env.PORT || 3000);
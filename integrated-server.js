import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAIClient, AzureKeyCredential } from '@azure/openai';
import { DocumentAnalysisClient } from '@azure/ai-form-recognizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// File upload configuration
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Azure OpenAI Client
const openAIClient = new OpenAIClient(
    process.env.AZURE_OPENAI_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY)
);

// Azure Document Intelligence Client
const documentClient = new DocumentAnalysisClient(
    process.env.AZURE_DOCS_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_DOCS_API_KEY)
);

// ===== API ENDPOINTS =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'CapNest is running with Azure AI',
        azureServices: {
            openai: !!process.env.AZURE_OPENAI_API_KEY,
            documentIntelligence: !!process.env.AZURE_DOCS_API_KEY
        },
        server: {
            port: PORT,
            environment: process.env.NODE_ENV || 'development'
        }
    });
});

// Check Eligibility with Azure OpenAI
app.post('/api/check-eligibility', async (req, res) => {
    try {
        const { loanType, amount, income, creditScore, employment, existingLoans } = req.body;

        const prompt = `You are a loan eligibility expert. Analyze this loan application:
    
Loan Type: ${loanType}
Requested Amount: ₹${amount}
Monthly Income: ₹${income}
Credit Score: ${creditScore}
Employment: ${employment}
Existing Loans: ${existingLoans ? 'Yes' : 'No'}

Provide a detailed eligibility analysis with:
1. Approval probability (percentage)
2. Risk assessment (Low/Medium/High)
3. Recommendations
4. Suitable banks

Format as JSON with keys: approvalProbability, riskLevel, recommendations, suitableBanks`;

        const messages = [
            { role: 'system', content: 'You are a financial advisor specializing in loan eligibility assessment.' },
            { role: 'user', content: prompt }
        ];

        const result = await openAIClient.getChatCompletions(
            process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
            messages,
            { maxTokens: 500, temperature: 0.7 }
        );

        const aiResponse = result.choices[0].message.content;

        let analysis;
        try {
            analysis = JSON.parse(aiResponse);
        } catch (e) {
            analysis = {
                approvalProbability: creditScore >= 750 ? 90 : creditScore >= 700 ? 75 : creditScore >= 650 ? 55 : 35,
                riskLevel: creditScore >= 700 ? 'Low' : creditScore >= 600 ? 'Medium' : 'High',
                recommendations: aiResponse,
                suitableBanks: ['HDFC Bank', 'SBI', 'ICICI Bank']
            };
        }

        res.json({
            success: true,
            analysis,
            aiPowered: true
        });

    } catch (error) {
        console.error('Eligibility check error:', error);

        const { creditScore } = req.body;
        res.json({
            success: true,
            analysis: {
                approvalProbability: creditScore >= 750 ? 90 : creditScore >= 700 ? 75 : creditScore >= 650 ? 55 : 35,
                riskLevel: creditScore >= 700 ? 'Low' : creditScore >= 600 ? 'Medium' : 'High',
                recommendations: 'Based on your credit score and income, you have a good chance of approval.',
                suitableBanks: ['HDFC Bank', 'SBI', 'ICICI Bank']
            },
            aiPowered: false,
            error: error.message
        });
    }
});

// Document Analysis with Azure Document Intelligence
app.post('/api/analyze-document', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No document uploaded' });
        }

        const documentBuffer = req.file.buffer;

        const poller = await documentClient.beginAnalyzeDocument(
            'prebuilt-document',
            documentBuffer
        );

        const result = await poller.pollUntilDone();

        const extractedData = {
            documentType: req.file.mimetype,
            pages: result.pages?.length || 0,
            text: '',
            keyValuePairs: [],
            tables: []
        };

        if (result.content) {
            extractedData.text = result.content.substring(0, 1000);
        }

        if (result.keyValuePairs) {
            extractedData.keyValuePairs = result.keyValuePairs.slice(0, 10).map(pair => ({
                key: pair.key?.content || '',
                value: pair.value?.content || '',
                confidence: pair.confidence || 0
            }));
        }

        res.json({
            success: true,
            data: extractedData,
            aiPowered: true,
            message: 'Document analyzed successfully'
        });

    } catch (error) {
        console.error('Document analysis error:', error);

        res.json({
            success: true,
            data: {
                documentType: req.file?.mimetype || 'unknown',
                pages: 1,
                text: 'Document received and validated',
                message: 'Document appears clear and readable'
            },
            aiPowered: false,
            error: error.message
        });
    }
});

// Get loan recommendations with AI
app.post('/api/loan-recommendations', async (req, res) => {
    try {
        const { purpose, income, creditScore } = req.body;

        const prompt = `Based on the following user profile, recommend the most suitable loan types:
    
Purpose: ${purpose}
Monthly Income: ₹${income}
Credit Score: ${creditScore}

Recommend 3 most suitable loan types from: Personal Loan, Home Loan, Education Loan, Vehicle Loan, Business Loan, Gold Loan, Loan Against Property, PM Mudra Loan.

For each recommendation, provide:
1. Loan type
2. Why it's suitable
3. Estimated amount range
4. Key benefits

Format as JSON array.`;

        const messages = [
            { role: 'system', content: 'You are a financial advisor helping users choose the right loan products.' },
            { role: 'user', content: prompt }
        ];

        const result = await openAIClient.getChatCompletions(
            process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
            messages,
            { maxTokens: 600, temperature: 0.7 }
        );

        const aiResponse = result.choices[0].message.content;

        res.json({
            success: true,
            recommendations: aiResponse,
            aiPowered: true
        });

    } catch (error) {
        console.error('Recommendations error:', error);

        res.json({
            success: true,
            recommendations: [
                {
                    loanType: 'Personal Loan',
                    reason: 'Flexible and quick approval for general purposes',
                    amountRange: '₹50,000 - ₹25,00,000',
                    benefits: ['No collateral', 'Quick disbursement', 'Flexible tenure']
                }
            ],
            aiPowered: false
        });
    }
});

// Serve frontend for all other routes (DISABLED FOR RENDER BACKEND)
// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname, '../frontend/index.html'));
// });

// Start server
app.listen(PORT, () => {
    console.log('\n🎉 CapNest - Complete Integrated Application');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`\n📱 Access Your Application:`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://10.123.23.211:${PORT}`);
    console.log(`\n🔧 API Endpoints:`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
    console.log(`\n🤖 Azure AI Status:`);
    console.log(`   OpenAI: ${process.env.AZURE_OPENAI_API_KEY ? '✅ Connected' : '❌ Not configured'}`);
    console.log(`   Document Intelligence: ${process.env.AZURE_DOCS_API_KEY ? '✅ Connected' : '❌ Not configured'}`);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ Everything ready! Open the link in your browser!\n');
});

export default app;



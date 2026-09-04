export interface SubPage {
  url: string;
  title: string;
  description: string;
}

export interface Site {
  key: string;
  name: string;
  homepage: string;
  tagline: string;
  subPages: SubPage[];
  topics: string[];
}

export const SITES: Site[] = [
  {
    key: "digital-marketing",
    name: "Digital.Marketing",
    homepage: "https://digital.marketing",
    tagline: "The definitive resource for digital marketing strategy, tools, and growth",
    subPages: [
      { url: "https://digital.marketing/content-marketing", title: "Content Marketing", description: "A deep-dive into content marketing strategy for B2B and B2C brands" },
      { url: "https://digital.marketing/services", title: "Services", description: "Full-service digital marketing offerings from strategy through execution" },
      { url: "https://digital.marketing/industries", title: "Industries", description: "How digital marketing strategy differs across industries and verticals" },
      { url: "https://digital.marketing/pricing", title: "Pricing", description: "Transparent pricing for digital marketing services and retainers" },
    ],
    topics: ["digital marketing strategy", "content marketing", "marketing ROI", "B2B marketing", "growth marketing"],
  },
  {
    key: "seo-co",
    name: "SEO.co",
    homepage: "https://seo.co",
    tagline: "Expert SEO services and managed link building for businesses that want to rank",
    subPages: [
      { url: "https://seo.co/link-building/", title: "Link Building Services", description: "Managed, white-hat link building campaigns that move the needle on domain authority and rankings" },
      { url: "https://seo.co/on-page-seo/", title: "On-Page SEO", description: "On-page optimization services that align content with what search engines and users want" },
      { url: "https://seo.co/local-seo/", title: "Local SEO", description: "Local search optimization for businesses that need to rank in their city or region" },
      { url: "https://seo.co/ai/", title: "AI SEO", description: "How AI is reshaping SEO and what it means for organic search strategy" },
    ],
    topics: ["SEO strategy", "link building", "organic search", "search rankings", "technical SEO"],
  },
  {
    key: "dev-co",
    name: "DEV.co",
    homepage: "https://dev.co",
    tagline: "Custom software development and AI engineering for startups and enterprises",
    subPages: [
      { url: "https://dev.co/ai/application-development", title: "AI Application Development", description: "Custom AI application development from prototype to production-ready product" },
      { url: "https://dev.co/ai/agent-development", title: "AI Agent Development", description: "Building autonomous AI agents that handle complex workflows without manual intervention" },
      { url: "https://dev.co/ai/saas", title: "AI SaaS Development", description: "End-to-end development of AI-powered SaaS products built to scale" },
      { url: "https://dev.co/ai/workflow-automation", title: "AI Workflow Automation", description: "Automating business workflows with AI to eliminate repetitive work and reduce overhead" },
    ],
    topics: ["software development", "AI development", "SaaS", "custom software", "AI agents"],
  },
  {
    key: "ppc-co",
    name: "PPC.co",
    homepage: "https://ppc.co",
    tagline: "Managed PPC and paid search services that maximize return on ad spend",
    subPages: [
      { url: "https://ppc.co/blog/ppc-roi", title: "How to Measure PPC ROI", description: "The right metrics and frameworks for evaluating paid search campaign performance" },
      { url: "https://ppc.co/blog/ppc-guide-financial-advisors-rias-cfps", title: "PPC for Financial Advisors", description: "A complete paid search guide for financial advisors, RIAs, and CFPs trying to grow AUM" },
      { url: "https://ppc.co/blog/ppc-guide-accounting-firms", title: "PPC for Accounting Firms", description: "How accounting firms can use Google Ads to generate qualified leads year-round" },
      { url: "https://ppc.co/blog/ppc-guide-marketing-agencies", title: "PPC for Marketing Agencies", description: "How marketing agencies can use paid search to win new clients and grow retainers" },
    ],
    topics: ["paid advertising", "Google Ads", "PPC strategy", "ROAS optimization", "paid search"],
  },
  {
    key: "vdr-ai",
    name: "VDR.ai",
    homepage: "https://vdr.ai",
    tagline: "AI-powered virtual data rooms for secure document sharing in M&A and fundraising",
    subPages: [
      { url: "https://vdr.ai/platform/virtual-data-room", title: "Virtual Data Room Platform", description: "The AI-powered VDR platform built for M&A due diligence, fundraising, and secure deal management" },
      { url: "https://vdr.ai/security-center", title: "Security Center", description: "How VDR.ai secures sensitive documents with enterprise-grade encryption and access controls" },
      { url: "https://vdr.ai/platform", title: "Platform Overview", description: "A full overview of VDR.ai features for deal teams, investors, and legal advisors" },
      { url: "https://vdr.ai/pricing", title: "Pricing", description: "Transparent pricing for virtual data rooms based on deal size and team requirements" },
    ],
    topics: ["virtual data rooms", "due diligence", "M&A technology", "document security", "deal management"],
  },
  {
    key: "investmentbank",
    name: "InvestmentBank.com",
    homepage: "https://investmentbank.com",
    tagline: "Investment banking advisory for middle-market M&A, capital raising, and business sales",
    subPages: [
      { url: "https://investmentbank.com/services", title: "Investment Banking Services", description: "Full-service M&A advisory, capital raising, and sell-side representation for middle-market companies" },
      { url: "https://investmentbank.com/industries", title: "Industries We Serve", description: "Sector-specific investment banking expertise across technology, healthcare, manufacturing, and more" },
      { url: "https://investmentbank.com/about", title: "About", description: "The team and approach behind InvestmentBank.com's advisory practice" },
      { url: "https://investmentbank.com/advertising", title: "Advertising & Media M&A", description: "M&A advisory for advertising, media, and marketing services businesses" },
    ],
    topics: ["investment banking", "M&A advisory", "business valuation", "capital raising", "middle market"],
  },
  {
    key: "mna",
    name: "MergersandAcquisitions.net",
    homepage: "https://mergersandacquisitions.net",
    tagline: "M&A advisory for buying, selling, and valuing businesses across every industry",
    subPages: [
      { url: "https://mergersandacquisitions.net/due-diligence-checklist", title: "Due Diligence Checklist", description: "A comprehensive checklist for buyers and sellers navigating M&A due diligence" },
      { url: "https://mergersandacquisitions.net/services", title: "M&A Services", description: "Buy-side and sell-side advisory, valuation, and deal structuring services" },
      { url: "https://mergersandacquisitions.net/industries", title: "Industries", description: "Industry-specific M&A advisory across technology, healthcare, manufacturing, and consumer brands" },
      { url: "https://mergersandacquisitions.net/about", title: "About", description: "The team and track record behind MergersandAcquisitions.net" },
    ],
    topics: ["mergers and acquisitions", "deal structuring", "due diligence", "business sales", "M&A strategy"],
  },
  {
    key: "llm-co",
    name: "LLM.co",
    homepage: "https://llm.co",
    tagline: "Enterprise LLM resources, model comparisons, and private AI implementation guides",
    subPages: [
      { url: "https://llm.co/blog/ai-agents-for-finance", title: "AI Agents for Finance", description: "How financial services firms are deploying AI agents to automate reporting, compliance, and analysis" },
      { url: "https://llm.co/blog/why-data-residency-laws-are-accelerating-private-ai-adoption", title: "Data Residency and Private AI", description: "How data residency regulations are pushing enterprises toward private, locally-hosted LLM deployments" },
      { url: "https://llm.co/blog/how-enterprises-are-using-local-llms-for-fraud-detection", title: "Local LLMs for Fraud Detection", description: "How banks and fintechs are using locally-hosted language models to detect fraud without exposing sensitive data" },
      { url: "https://llm.co/blog/from-pdf-hell-to-structured-insights-using-local-llm-pipelines", title: "PDF to Structured Insights with LLMs", description: "Turning unstructured documents into structured data using local LLM pipelines" },
    ],
    topics: ["large language models", "enterprise AI", "private AI", "LLM implementation", "generative AI"],
  },
  {
    key: "sec-co",
    name: "SEC.co",
    homepage: "https://sec.co",
    tagline: "Cybersecurity services, compliance frameworks, and enterprise security solutions",
    subPages: [
      { url: "https://sec.co/compliance/hipaa", title: "HIPAA Compliance", description: "HIPAA compliance services for healthcare organizations handling protected health information" },
      { url: "https://sec.co/compliance/iso-27001", title: "ISO 27001 Certification", description: "Achieving ISO 27001 certification for enterprise information security management" },
      { url: "https://sec.co/compliance/pci-dss", title: "PCI DSS Compliance", description: "PCI DSS compliance services for businesses that process credit card payments" },
      { url: "https://sec.co/blog/ai-vs-ai-how-machine-learning-is-both-a-cybersecurity-threat-and-solution", title: "AI vs AI in Cybersecurity", description: "How machine learning is simultaneously being used by attackers and defenders in modern cybersecurity" },
    ],
    topics: ["cybersecurity", "compliance", "information security", "HIPAA", "enterprise security"],
  },
  {
    key: "vb-co",
    name: "VB.co",
    homepage: "https://vb.co",
    tagline: "The AI-first operational OS for modern businesses",
    subPages: [
      { url: "https://vb.co/operational-os", title: "Operational OS", description: "The ViBe operational OS — a unified AI-powered system for running every part of your business" },
      { url: "https://vb.co/ai-agents", title: "AI Agents", description: "Autonomous AI agents that handle operations, communications, and decision-support across your team" },
      { url: "https://vb.co/operational-os/ai-maturity-model", title: "AI Maturity Model", description: "A framework for understanding where your business is on the AI adoption curve and what comes next" },
      { url: "https://vb.co/operational-os/integrations", title: "Integrations", description: "How ViBe connects with the tools your team already uses — from CRMs to financial systems" },
    ],
    topics: ["business software", "AI operations", "team productivity", "business OS", "AI agents"],
  },
  {
    key: "projectmanager",
    name: "ProjectManager.co",
    homepage: "https://projectmanager.co",
    tagline: "Project management software built for middle-market teams that need more than Asana",
    subPages: [
      { url: "https://projectmanager.co/platform/", title: "Platform", description: "The full ProjectManager.co feature set for teams managing complex, multi-stakeholder projects" },
      { url: "https://projectmanager.co/why-middle-market/", title: "Why Middle Market", description: "Why mid-sized companies outgrow Asana and Monday and what they need instead" },
      { url: "https://projectmanager.co/compare/asana/", title: "vs Asana", description: "A side-by-side comparison of ProjectManager.co and Asana for enterprise and mid-market teams" },
      { url: "https://projectmanager.co/pricing/", title: "Pricing", description: "Pricing plans for teams of any size, with self-hosted and cloud deployment options" },
    ],
    topics: ["project management", "team productivity", "enterprise software", "project planning", "remote teams"],
  },
  {
    key: "privateequity",
    name: "PrivateEquityInvestor.com",
    homepage: "https://privateequityinvestor.com",
    tagline: "AI-powered tools and insights for private equity firms, analysts, and investors",
    subPages: [
      { url: "https://privateequityinvestor.com/platform/ai-business-valuations", title: "AI Business Valuations", description: "Automated business valuation tools that give PE firms faster, data-driven deal assessments" },
      { url: "https://privateequityinvestor.com/platform/ai-cim", title: "AI CIM Generation", description: "Generating Confidential Information Memorandums with AI to accelerate deal marketing" },
      { url: "https://privateequityinvestor.com/platform", title: "Platform", description: "The full PrivateEquityInvestor.com platform for deal sourcing, analysis, and portfolio management" },
      { url: "https://privateequityinvestor.com/solutions", title: "Solutions", description: "How private equity firms use PrivateEquityInvestor.com to find, evaluate, and close better deals" },
    ],
    topics: ["private equity", "deal sourcing", "business valuation", "PE technology", "investment analysis"],
  },
  {
    key: "realestate",
    name: "RealEstateInvestor.net",
    homepage: "https://realestateinvestor.net",
    tagline: "Real estate investment advisory for deal sourcing, underwriting, and acquisitions",
    subPages: [
      { url: "https://realestateinvestor.net/services/deal-sourcing", title: "Deal Sourcing", description: "Proprietary deal flow and off-market acquisition opportunities for real estate investors" },
      { url: "https://realestateinvestor.net/services/deal-underwriting", title: "Deal Underwriting", description: "Professional underwriting services that help investors quickly assess deal viability and returns" },
      { url: "https://realestateinvestor.net/services/investment-memos", title: "Investment Memos", description: "Professionally prepared investment memorandums for real estate acquisitions and LP presentations" },
      { url: "https://realestateinvestor.net/services/off-market-deals", title: "Off-Market Deals", description: "Access to off-market real estate deals not available through brokers or listing platforms" },
    ],
    topics: ["real estate investing", "deal sourcing", "property acquisition", "commercial real estate", "investment returns"],
  },
  {
    key: "link-build",
    name: "Link.Build",
    homepage: "https://link.build",
    tagline: "Managed link building services for SEO agencies, brands, and in-house teams",
    subPages: [
      { url: "https://link.build/solutions", title: "Link Building Solutions", description: "Tailored link building solutions for brands, agencies, and in-house SEO teams at every scale" },
      { url: "https://link.build/guides", title: "Link Building Guides", description: "In-depth guides covering link acquisition strategy, outreach, and measuring link impact" },
      { url: "https://link.build/link-building-glossary", title: "Link Building Glossary", description: "A complete glossary of link building and SEO terms for practitioners and beginners alike" },
      { url: "https://link.build/white-label", title: "White Label Link Building", description: "White label link building for agencies that want to deliver results under their own brand" },
    ],
    topics: ["link building", "SEO", "domain authority", "backlink strategy", "white label SEO"],
  },
  {
    key: "pr-digital",
    name: "PR.Digital",
    homepage: "https://pr.digital",
    tagline: "Digital PR services that earn high-authority coverage, backlinks, and brand visibility",
    subPages: [
      { url: "https://pr.digital/how-to-get-featured-in-top-tier-publications-without-paying-for-ads", title: "Get Featured Without Paying for Ads", description: "How to earn editorial coverage in top-tier publications through digital PR, not paid placements" },
      { url: "https://pr.digital/how-to-run-a-successful-digital-pr-campaign", title: "How to Run a Digital PR Campaign", description: "A step-by-step guide to planning and executing a digital PR campaign that generates real coverage" },
      { url: "https://pr.digital/digital-pr-strategies-for-saas-startups", title: "Digital PR for SaaS Startups", description: "Digital PR tactics specifically for SaaS companies looking to build authority and earn backlinks fast" },
      { url: "https://pr.digital/how-to-build-high-authority-backlinks-using-digital-pr", title: "High-Authority Backlinks via Digital PR", description: "How digital PR generates the kind of editorial backlinks that move the needle on domain authority" },
    ],
    topics: ["digital PR", "media coverage", "link building", "brand awareness", "press outreach"],
  },
];

export const DIGITAL_MARKETING_SITE_KEYS = [
  "digital-marketing",
  "seo-co",
  "ppc-co",
  "dev-co",
  "link-build",
  "pr-digital",
];

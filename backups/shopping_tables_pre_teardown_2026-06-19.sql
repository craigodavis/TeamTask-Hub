--
-- PostgreSQL database dump
--

-- Dumped from database version 13.23
-- Dumped by pg_dump version 13.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: shopping_inventory; Type: TABLE; Schema: teamtask_hub; Owner: -
--

CREATE TABLE teamtask_hub.shopping_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shopping_item_id uuid NOT NULL,
    location_id uuid,
    company_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    current_qty numeric(10,2) DEFAULT 0,
    last_counted_at timestamp with time zone,
    last_counted_by uuid
);


--
-- Name: shopping_inventory_log; Type: TABLE; Schema: teamtask_hub; Owner: -
--

CREATE TABLE teamtask_hub.shopping_inventory_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shopping_item_id uuid NOT NULL,
    location_id uuid,
    company_id uuid NOT NULL,
    qty numeric(10,2) NOT NULL,
    counted_by uuid,
    counted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shopping_item_locations; Type: TABLE; Schema: teamtask_hub; Owner: -
--

CREATE TABLE teamtask_hub.shopping_item_locations (
    shopping_item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: shopping_item_purchases; Type: TABLE; Schema: teamtask_hub; Owner: -
--

CREATE TABLE teamtask_hub.shopping_item_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shopping_item_id uuid NOT NULL,
    receipt_item_id uuid,
    company_id uuid NOT NULL,
    vendor text,
    description_raw text,
    price numeric(10,2),
    quantity numeric(10,2),
    purchase_date date,
    matched_by text DEFAULT 'manual'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    quantity_purchased numeric(10,2),
    unit text,
    unit_price numeric(10,4),
    CONSTRAINT shopping_item_purchases_matched_by_check CHECK ((matched_by = ANY (ARRAY['ai'::text, 'manual'::text, 'auto'::text])))
);


--
-- Name: shopping_items; Type: TABLE; Schema: teamtask_hub; Owner: -
--

CREATE TABLE teamtask_hub.shopping_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    category text,
    par_qty numeric(10,2),
    par_unit text DEFAULT 'box'::text,
    is_routine boolean DEFAULT false NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    buy_frequency text,
    buy_day_of_week integer,
    buy_day_of_month integer,
    buy_week_of_month integer,
    CONSTRAINT shopping_items_buy_day_of_month_check CHECK (((buy_day_of_month >= 1) AND (buy_day_of_month <= 31))),
    CONSTRAINT shopping_items_buy_day_of_week_check CHECK (((buy_day_of_week >= 0) AND (buy_day_of_week <= 6))),
    CONSTRAINT shopping_items_buy_frequency_check CHECK ((buy_frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text, 'monthly_weekday'::text, 'adhoc'::text]))),
    CONSTRAINT shopping_items_buy_week_of_month_check CHECK (((buy_week_of_month >= 1) AND (buy_week_of_month <= 5)))
);


--
-- Data for Name: shopping_inventory; Type: TABLE DATA; Schema: teamtask_hub; Owner: -
--

COPY teamtask_hub.shopping_inventory (id, shopping_item_id, location_id, company_id, sort_order, current_qty, last_counted_at, last_counted_by) FROM stdin;
\.


--
-- Data for Name: shopping_inventory_log; Type: TABLE DATA; Schema: teamtask_hub; Owner: -
--

COPY teamtask_hub.shopping_inventory_log (id, shopping_item_id, location_id, company_id, qty, counted_by, counted_at) FROM stdin;
\.


--
-- Data for Name: shopping_item_locations; Type: TABLE DATA; Schema: teamtask_hub; Owner: -
--

COPY teamtask_hub.shopping_item_locations (shopping_item_id, location_id, company_id) FROM stdin;
ef1f99fc-1480-43db-8d43-f7f0ef155415	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
ef1f99fc-1480-43db-8d43-f7f0ef155415	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
934588c8-025d-4f5d-b9f9-619c5e30e960	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
934588c8-025d-4f5d-b9f9-619c5e30e960	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
31f6b943-686f-45d2-b71e-0c63f9296389	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
31f6b943-686f-45d2-b71e-0c63f9296389	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
5712755e-7a54-4acb-b4c9-5118ef5f8391	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
5712755e-7a54-4acb-b4c9-5118ef5f8391	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
35c04141-38c1-42af-85b1-8434ca2e0357	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
35c04141-38c1-42af-85b1-8434ca2e0357	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
42a7325e-9277-4516-834d-bdb0327be5c1	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
42a7325e-9277-4516-834d-bdb0327be5c1	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
20cc4c48-d172-4fd2-b441-35a11ffeb4af	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
20cc4c48-d172-4fd2-b441-35a11ffeb4af	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
5f47fe75-ad84-44ad-b480-e69e20c1abde	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
5f47fe75-ad84-44ad-b480-e69e20c1abde	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
7d55e450-288a-4a19-90b0-70a30fedc198	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
7d55e450-288a-4a19-90b0-70a30fedc198	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
3d4cb702-48e9-40b6-abeb-d67b5a6b829a	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
3d4cb702-48e9-40b6-abeb-d67b5a6b829a	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
b761391a-0371-4762-b0ea-9a475e6bd29b	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
b761391a-0371-4762-b0ea-9a475e6bd29b	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
1f29b1ba-24bb-450e-adc0-66227bb7792f	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
9f167fbe-0226-4644-b4f4-0040afa64fcc	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
9f167fbe-0226-4644-b4f4-0040afa64fcc	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
f1d0c2fb-549b-4b61-9d88-4c331868107a	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
f1d0c2fb-549b-4b61-9d88-4c331868107a	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
c8a6b915-81af-43ba-aed2-840838f10bb1	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
c8a6b915-81af-43ba-aed2-840838f10bb1	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
0272ba25-0b10-458f-8202-516b47b4579c	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
0272ba25-0b10-458f-8202-516b47b4579c	9278d8c3-244d-4b5d-97c6-4aa406d26e77	8d2df498-b5c0-4f73-94cd-323956036113
cfccfb65-e50e-4d7a-920c-ef43552ed480	e4407602-2f86-4b2e-8fa8-04f1c8989dd9	8d2df498-b5c0-4f73-94cd-323956036113
\.


--
-- Data for Name: shopping_item_purchases; Type: TABLE DATA; Schema: teamtask_hub; Owner: -
--

COPY teamtask_hub.shopping_item_purchases (id, shopping_item_id, receipt_item_id, company_id, vendor, description_raw, price, quantity, purchase_date, matched_by, created_at, quantity_purchased, unit, unit_price) FROM stdin;
565aed6d-f715-44f6-b7e5-8ebad3d228db	934588c8-025d-4f5d-b9f9-619c5e30e960	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-10	manual	2026-06-01 14:02:42.083791+00	\N	\N	\N
0191690a-b9c9-4dfe-a236-25b631096fd9	ef1f99fc-1480-43db-8d43-f7f0ef155415	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-04-14	manual	2026-06-01 14:02:45.255785+00	\N	\N	\N
e28bebd8-cdc5-4683-8fa1-8eb9a26ce81c	0ceabcb1-47ea-43ed-a3ec-4b84024cb2eb	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-31	manual	2026-06-01 14:02:48.519812+00	\N	\N	\N
5b95418d-d0e8-4d3c-9b29-d239cc7abd64	c4817005-ccc0-4c09-931d-d307f5357605	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-20	manual	2026-06-01 14:02:51.155766+00	\N	\N	\N
eab43c0c-8e32-47a4-986c-b4dda3de98fe	31f6b943-686f-45d2-b71e-0c63f9296389	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-17	manual	2026-06-01 14:03:47.589862+00	\N	\N	\N
ba2b287e-1bfd-4627-a9b2-fdc183af4a62	5712755e-7a54-4acb-b4c9-5118ef5f8391	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-31	manual	2026-06-01 14:03:56.06884+00	\N	\N	\N
703a5feb-d336-48fb-b277-7f138f7d1d10	35c04141-38c1-42af-85b1-8434ca2e0357	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-04-14	manual	2026-06-01 14:06:48.241041+00	\N	\N	\N
a089085a-232a-494f-8917-6de9131920ee	0e705cf5-84ca-4b12-9d09-b5239b3de8d0	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-18	manual	2026-06-01 14:10:30.686212+00	\N	\N	\N
40c1e6d6-0bb9-4ed8-aa39-79d396f474d9	0272ba25-0b10-458f-8202-516b47b4579c	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	9.99	\N	2026-04-24	manual	2026-06-01 14:11:05.544442+00	\N	\N	\N
cf6f345b-0042-4e9c-ab37-4f31be6336db	6d56b6fc-4645-4a7c-a585-385a502702f2	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-04-07	manual	2026-06-01 14:11:13.234841+00	\N	\N	\N
8abd50b1-efe9-4d16-868a-401f86630d2f	8ddabe36-1090-4f68-8b8b-ecc740cf996f	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-31	manual	2026-06-01 14:11:23.774102+00	\N	\N	\N
f25fa347-34c9-490a-ab28-a19b213a4348	8f80129a-a3a9-4eb9-b5bd-9aa0ce9b91d6	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-29	manual	2026-06-01 14:11:26.51855+00	\N	\N	\N
f2a920ea-9865-4282-ba52-519d2668cdf8	be511e3f-8c18-435f-9842-d5bc3e9b11c6	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-25	manual	2026-06-01 14:11:28.280691+00	\N	\N	\N
561c0376-7fbe-4c4c-b4eb-5b020cc24241	2f38b967-f603-4998-a01d-3c4d8c9c4c0c	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-18	manual	2026-06-01 14:11:40.872642+00	\N	\N	\N
1edd48be-f64b-4f9a-8af9-951628893443	7d55e450-288a-4a19-90b0-70a30fedc198	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-03	manual	2026-06-01 14:11:50.238507+00	\N	\N	\N
a6b7f3a1-4099-41dd-8244-d16df0f223bc	eca5ac9b-ea3c-4e3f-a349-d9f0c83457e7	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-25	manual	2026-06-01 14:11:53.449768+00	\N	\N	\N
4d150433-b4e7-4bb4-b432-234c503af679	60017711-ed65-418e-b97b-e9c5f39e06bd	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-24	manual	2026-06-01 14:11:57.294231+00	\N	\N	\N
f350f8cb-a28f-4874-8dda-f3114cd8d197	27ba17c1-0f76-4729-a995-cf07cb9e9917	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-03	manual	2026-06-01 14:12:01.310585+00	\N	\N	\N
b461cd61-08e6-45f0-b739-db0f03dd370a	6407e2d1-dead-4f1a-aacf-e3a6c121bd39	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-04-14	manual	2026-06-01 14:13:06.652637+00	\N	\N	\N
980ca849-6092-44ba-a78d-4dd25d4f90c4	c8a6b915-81af-43ba-aed2-840838f10bb1	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	8.90	\N	2026-03-31	manual	2026-06-01 14:13:20.035262+00	\N	\N	\N
bef742da-1e00-4f9f-b264-bd4ff9a7071a	994bf274-ca68-43bc-8f9e-6bd9934135ab	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-31	manual	2026-06-01 14:13:24.303245+00	\N	\N	\N
1f48ac7e-2576-47b5-bfe3-56f9279d12c9	20cc4c48-d172-4fd2-b441-35a11ffeb4af	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	14.99	\N	2026-03-31	manual	2026-06-01 14:13:28.001486+00	\N	\N	\N
bc926cfd-f2f2-4f1e-98af-87df6f8aac15	5f47fe75-ad84-44ad-b480-e69e20c1abde	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-25	manual	2026-06-01 14:13:54.092794+00	\N	\N	\N
a26ac0e6-e708-4b18-bfa7-f99d5d071316	abcade04-188b-47c5-9188-04bd85f22d4c	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-22	manual	2026-06-01 14:13:56.484869+00	\N	\N	\N
c747e842-7e85-4853-beea-9dac3ab76274	42a7325e-9277-4516-834d-bdb0327be5c1	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-18	manual	2026-06-01 14:14:04.532661+00	\N	\N	\N
3a60e615-dbfc-4216-9677-765f933179f7	fcd6157c-98d1-4012-b356-3d54213f7af2	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-18	manual	2026-06-01 14:14:11.521114+00	\N	\N	\N
649b2a2c-4802-4088-b1bd-484ce4cd5cca	0d4540c4-c590-4e4c-95c3-4703ae6e1820	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-18	manual	2026-06-01 14:14:15.012091+00	\N	\N	\N
c4ed08fa-3c7e-4b17-b842-58d5ed97a531	5b3a0533-ce48-4e5c-93ee-f9af769c2341	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-18	manual	2026-06-01 14:16:41.408569+00	\N	\N	\N
88fe62b1-218e-4618-af28-acef1efcb821	2056dca1-2e5d-44e5-acf0-a8d67a983819	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-14	manual	2026-06-01 14:18:13.684163+00	\N	\N	\N
36347d33-4c06-4720-bb91-7d53e985f9f5	513b4a0d-5b14-4489-9f07-959e58b19ba3	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-10	manual	2026-06-01 14:18:23.460135+00	\N	\N	\N
24973b8f-4a4f-42df-9c1b-17e1640abb5d	a252554b-7725-4933-ba08-535d8c450495	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-03	manual	2026-06-01 14:18:54.000147+00	\N	\N	\N
9110f4b4-0b67-40ca-95c1-3357d7686e55	3681a1d9-1cf8-4100-868e-d2b251e54994	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-03	manual	2026-06-01 14:18:56.748359+00	\N	\N	\N
5f0ec2cf-1d76-48ff-bd5b-dc38c8032734	47c5c273-26d7-4cf8-87eb-f3d426d32a3e	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-03	manual	2026-06-01 14:18:59.861176+00	\N	\N	\N
dbf67a4e-126c-4ac3-af82-2312708a7b09	fb283e74-0bc1-47ff-a19f-95f0a73dcdb4	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-02	manual	2026-06-01 14:19:06.592813+00	\N	\N	\N
303d64c1-a3c7-4063-b275-b7f8ebdd6003	6b05c99e-aba4-4d18-be1a-1208ed861330	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-04	manual	2026-06-01 14:21:52.193406+00	\N	\N	\N
ee547ac1-bf66-4712-a8ed-f3341e7976cb	ea3ae886-d2c4-4358-8962-0f847f3e9a42	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-04	manual	2026-06-01 14:21:54.285347+00	\N	\N	\N
d9b9227a-acb6-40f9-84a8-f5901b665a13	1f29b1ba-24bb-450e-adc0-66227bb7792f	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	\N	manual	2026-06-01 14:23:04.06538+00	\N	\N	\N
8247d182-0117-4697-86d7-9a11fbe2fa18	1fee12b1-01da-4bfa-855b-660ece2a0ce2	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	\N	manual	2026-06-01 14:23:29.344639+00	\N	\N	\N
8cbfefd2-3733-44ec-8775-74a87ef369a7	a0c8c8d9-ade6-4f37-9224-f431ed2b6be2	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-06	manual	2026-06-01 14:23:38.156496+00	\N	\N	\N
fca642b8-ca10-4656-af46-459fa7d96217	9f167fbe-0226-4644-b4f4-0040afa64fcc	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-06	manual	2026-06-01 14:23:42.352242+00	\N	\N	\N
7a2ec112-49f5-4fbb-8816-6530f51186f3	01dbf247-453a-404b-a111-f84468c09d1f	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-06	manual	2026-06-01 14:23:44.168049+00	\N	\N	\N
ea1683dc-606d-4bba-be7c-2c73f48c1dbe	a261b22b-ee7f-4547-ba01-f26b4f691c10	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-08	manual	2026-06-01 14:23:46.036388+00	\N	\N	\N
feeb85a7-9df7-41d7-9e2f-d160d515463e	f3e6c7d2-8348-4f6a-bf67-eb574e817711	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-13	manual	2026-06-01 14:23:49.040547+00	\N	\N	\N
01dcef09-7eb2-4e61-8c2d-68ded5cd7abc	db07d174-f82b-4a4e-9429-bf3d1d9188f7	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-13	manual	2026-06-01 14:23:52.187999+00	\N	\N	\N
f330cafb-f7a3-4334-83e4-274738133f3d	9ff1e848-efe6-4112-88db-d119d422cc4a	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-13	manual	2026-06-01 14:23:58.041614+00	\N	\N	\N
a202a2dc-6f7f-4656-a1e6-34a24e8c0afc	eee16295-fbd2-4bef-b1f0-5dee3f8e9a2a	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-25	manual	2026-06-01 14:24:11.325222+00	\N	\N	\N
dde3498d-fea3-422e-bbdc-e8a6e2086ab4	3d4cb702-48e9-40b6-abeb-d67b5a6b829a	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-24	manual	2026-06-01 14:24:15.377388+00	\N	\N	\N
e522fe55-0c51-40c1-82d3-a26259621d67	b761391a-0371-4762-b0ea-9a475e6bd29b	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-03-01	manual	2026-06-01 14:24:22.201319+00	\N	\N	\N
abf2ed90-1d26-4706-abd6-765552464ca0	ac7c1db5-32b1-45c0-ba7c-65293de97209	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-18	manual	2026-06-01 14:24:27.968857+00	\N	\N	\N
3184e3ef-0c0d-41f5-81a5-f8cceddede15	cfccfb65-e50e-4d7a-920c-ef43552ed480	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-04	manual	2026-06-01 14:24:41.837287+00	\N	\N	\N
32074842-ef47-4b15-b0a2-0808b5c8e940	ca2d6056-28b8-4a1d-bc07-ecad76ce22c4	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-20	manual	2026-06-01 14:24:44.737371+00	\N	\N	\N
a53da97b-a1ac-4ef7-974a-82cdc2ba8561	9784f7e6-9cfc-4e9a-9e41-3ff4bd67ee0f	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-01-20	manual	2026-06-01 14:24:58.392775+00	\N	\N	\N
0135a5d7-e86d-46f7-aa01-1ddc0cfafb42	2f38b967-f603-4998-a01d-3c4d8c9c4c0c	\N	8d2df498-b5c0-4f73-94cd-323956036113	Amazon	\N	\N	\N	2026-02-17	manual	2026-06-01 14:24:30.049013+00	\N	\N	\N
\.


--
-- Data for Name: shopping_items; Type: TABLE DATA; Schema: teamtask_hub; Owner: -
--

COPY teamtask_hub.shopping_items (id, company_id, name, description, category, par_qty, par_unit, is_routine, notes, created_by, created_at, updated_at, buy_frequency, buy_day_of_week, buy_day_of_month, buy_week_of_month) FROM stdin;
0ceabcb1-47ea-43ed-a3ec-4b84024cb2eb	8d2df498-b5c0-4f73-94cd-323956036113	L LIKED Dissolvable Labels, 2x1 Inch, 300 Stickers, Use by Food Rotation Labels for Storage and Container	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:02:48.191892+00	2026-06-01 14:02:48.191892+00	\N	\N	\N	\N
c4817005-ccc0-4c09-931d-d307f5357605	8d2df498-b5c0-4f73-94cd-323956036113	Partanna Pitted Castelvetrano Olives - Authentic Sicilian - Product Of Italy - Premium Handpicked Imported Italian Green Olives Great For Every Occasion - 9oz Jar	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:02:50.887715+00	2026-06-01 14:02:50.887715+00	\N	\N	\N	\N
994bf274-ca68-43bc-8f9e-6bd9934135ab	8d2df498-b5c0-4f73-94cd-323956036113	Georgia-Pacific Pacific Blue Basic 2-Ply Embossed Toilet Paper, 19880/01, 550 Sheets Per Roll, 80 Rolls Per Case	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:13:23.958909+00	2026-06-01 14:13:23.958909+00	\N	\N	\N	\N
ef1f99fc-1480-43db-8d43-f7f0ef155415	8d2df498-b5c0-4f73-94cd-323956036113	Roland Foods Fig Balsamic Vinegar Glaze of Modena, Specialty Imported Food, 12.84-Ounce	\N	\N	3.00	bottles	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:02:44.979706+00	2026-06-01 14:03:38.461302+00	\N	\N	\N	\N
934588c8-025d-4f5d-b9f9-619c5e30e960	8d2df498-b5c0-4f73-94cd-323956036113	BagDream Kraft Paper Bags 5.25x3.25x13 Inches 50Pcs Kraft Brown Paper Wine Bags with Handles Bulk for Wine, Gift, Party Favor	\N	Wine Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:02:41.71032+00	2026-06-01 14:07:08.032523+00	\N	\N	\N	\N
31f6b943-686f-45d2-b71e-0c63f9296389	8d2df498-b5c0-4f73-94cd-323956036113	DIVINA Organic Castelvetrano Pitted Olives, 10.6 oz	\N	Food	4.00	Jars	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:03:47.364973+00	2026-06-01 14:07:37.597414+00	\N	\N	\N	\N
c8a6b915-81af-43ba-aed2-840838f10bb1	8d2df498-b5c0-4f73-94cd-323956036113	1000 Removable Food Labels, Water/Oil/Tear Resistant Blank Stickers with Perforation Line for Food Containers, Freezer, Fridge, Jars, Pantry, Organization (1" x 2")	\N	Kitchen Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:13:19.655164+00	2026-06-02 05:55:41.711983+00	\N	\N	\N	\N
5712755e-7a54-4acb-b4c9-5118ef5f8391	8d2df498-b5c0-4f73-94cd-323956036113	Sanpellegrino Italian Sparkling Drink Melograno And Arancia, Sparkling Orange And Pomegranate Beverage, 24 Pack Of Cans	\N	Food	1.00	Case	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:03:55.420798+00	2026-06-01 14:09:04.404964+00	\N	\N	\N	\N
abcade04-188b-47c5-9188-04bd85f22d4c	8d2df498-b5c0-4f73-94cd-323956036113	McCormick Salt & Pepper Grinder Variety Pack, Himalayan Pink Salt, Sea Salt, Black Peppercorn, and Peppercorn Medley, 6.47 oz	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:13:56.132685+00	2026-06-01 14:13:56.132685+00	\N	\N	\N	\N
35c04141-38c1-42af-85b1-8434ca2e0357	8d2df498-b5c0-4f73-94cd-323956036113	TROUSKAIG 100pcs 10 inch Unbleached Parchment Paper Sheets for baking, Precut Heavy Duty Parchment Paper Rounds, Brown Non-Stick liners for Cake Pan, Steaming, Air Fryer, Non-Stick Liners for Cooking	\N	Kitchen Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:06:47.888951+00	2026-06-01 14:09:33.007622+00	\N	\N	\N	\N
0e705cf5-84ca-4b12-9d09-b5239b3de8d0	8d2df498-b5c0-4f73-94cd-323956036113	Antico Molino Napoli Antimo Caputo Pizza Flour, Gluten Free, 2.2 Pound (Pack of 2)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:10:30.381843+00	2026-06-01 14:10:30.381843+00	\N	\N	\N	\N
6d56b6fc-4645-4a7c-a585-385a502702f2	8d2df498-b5c0-4f73-94cd-323956036113	Bioda Multi-Purpose Probiotic Enzyme Cleaner and Deodorizer | Professional Strength | Trash Can Deodorizer, Pet Stains and Odors, Drains, Floors, Bathrooms, Toilets | Made in USA | 1 Gallon	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:12.886475+00	2026-06-01 14:11:12.886475+00	\N	\N	\N	\N
8ddabe36-1090-4f68-8b8b-ecc740cf996f	8d2df498-b5c0-4f73-94cd-323956036113	Industrial Paper Towels 10 x 800 White Roll Towels High Capacity Premium Quality (TAD Fabric Cloth Like Texture) Fits To uchless Automatic Commercial Towel Dispenser (Packed 6 Rolls)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:23.505829+00	2026-06-01 14:11:23.505829+00	\N	\N	\N	\N
8f80129a-a3a9-4eb9-b5bd-9aa0ce9b91d6	8d2df498-b5c0-4f73-94cd-323956036113	Amazon Basics Clear Thermal Laminating Plastic Paper Laminator Sheets, 9 x 11.5-Inch, 200-Pack, 2.8mil	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:25.87028+00	2026-06-01 14:11:25.87028+00	\N	\N	\N	\N
be511e3f-8c18-435f-9842-d5bc3e9b11c6	8d2df498-b5c0-4f73-94cd-323956036113	Active Element Commercial Dishwasher Detergent - Makes One 5 Gallon Pail - Industrial Dish Detergent - For High and Low Temp Dishwasher Machine	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:27.988954+00	2026-06-01 14:11:27.988954+00	\N	\N	\N	\N
2f38b967-f603-4998-a01d-3c4d8c9c4c0c	8d2df498-b5c0-4f73-94cd-323956036113	10 Pack Stainless Steel Scrubber, Steel Wool Scrubber for Scouring Stubborn Messes from Pots and Pans, Stoves, Broiler Racks, Grills and More	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:40.560675+00	2026-06-01 14:11:40.560675+00	\N	\N	\N	\N
eca5ac9b-ea3c-4e3f-a349-d9f0c83457e7	8d2df498-b5c0-4f73-94cd-323956036113	Homaxy 100% Cotton Waffle Weave Kitchen Dish Cloths, Ultra Soft Absorbent Quick Drying Dish Towels, 12 x 12 Inches, 6-Pack, Dark Grey	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:53.109661+00	2026-06-01 14:11:53.109661+00	\N	\N	\N	\N
60017711-ed65-418e-b97b-e9c5f39e06bd	8d2df498-b5c0-4f73-94cd-323956036113	Pompeian Smooth Extra Virgin Olive Oil, Contains Polyphenols, First Cold Pressed, 68 Fl Oz	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:56.929597+00	2026-06-01 14:11:56.929597+00	\N	\N	\N	\N
27ba17c1-0f76-4729-a995-cf07cb9e9917	8d2df498-b5c0-4f73-94cd-323956036113	CAMKYDE 4 oz Disposable Bagasse Fiber Souffle Cups 100pk, 100% Natural Biodegradable Compostable Condiment cups Sample Cup Tasting Cup (Natural, Pack of 100)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:12:00.946576+00	2026-06-01 14:12:00.946576+00	\N	\N	\N	\N
6407e2d1-dead-4f1a-aacf-e3a6c121bd39	8d2df498-b5c0-4f73-94cd-323956036113	Fly Trap Indoor Plug in - Electric Bug Zapper with Six Light - Silent, Pet Safe & Mess-Free Flying Insect Traps - Gnat Catcher & Fruit Fly Killer for House Home Kitchen Bedroom (1 Device + 1 Refill)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:13:06.396617+00	2026-06-01 14:13:06.396617+00	\N	\N	\N	\N
fcd6157c-98d1-4012-b356-3d54213f7af2	8d2df498-b5c0-4f73-94cd-323956036113	Steramine Quaternary Sanitizing Tablets - 150 Sanitizer Tablets per bottle, 3-Bottles	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:14:11.276857+00	2026-06-01 14:14:11.276857+00	\N	\N	\N	\N
0d4540c4-c590-4e4c-95c3-4703ae6e1820	8d2df498-b5c0-4f73-94cd-323956036113	San Francisco Bay Coffee - Dark Roast Whole Bean Coffee - French Roast (2 lb bag)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:14:14.641141+00	2026-06-01 14:14:14.641141+00	\N	\N	\N	\N
42a7325e-9277-4516-834d-bdb0327be5c1	8d2df498-b5c0-4f73-94cd-323956036113	Amarena Fabbri Wild Cherries in Syrup, Gluten Free, Non GMO, Vegan, 400 grams (14oz)	\N	Food	1.00	can	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:14:04.209387+00	2026-06-01 14:14:52.488749+00	\N	\N	\N	\N
5b3a0533-ce48-4e5c-93ee-f9af769c2341	8d2df498-b5c0-4f73-94cd-323956036113	Clean Revolution Multi Surface Cleaner Refill Supply, Non-Toxic, Eco-Friendly & Plant-Based, Ready to Use, Seaside Lavender, 128 Fl Oz (1 Gallon)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:16:41.092615+00	2026-06-01 14:16:41.092615+00	\N	\N	\N	\N
2056dca1-2e5d-44e5-acf0-a8d67a983819	8d2df498-b5c0-4f73-94cd-323956036113	Summmer Freeze Dried Raspberry Powder for Baking - 1.76 Oz Sugar Free, 100% Natural Flavoring for Smoothies - Sustainably Grown, Gluten-Free, Vegan Baking Powder	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:18:13.364598+00	2026-06-01 14:18:13.364598+00	\N	\N	\N	\N
513b4a0d-5b14-4489-9f07-959e58b19ba3	8d2df498-b5c0-4f73-94cd-323956036113	BagDream Kraft Paper Bags 5.25x3.25x13 Inches 50Pcs White Paper Wine Gift Bags with Handles Bulk for Wine, Gift, Retail, Party Favor	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:18:23.124299+00	2026-06-01 14:18:23.124299+00	\N	\N	\N	\N
a252554b-7725-4933-ba08-535d8c450495	8d2df498-b5c0-4f73-94cd-323956036113	Windex Glass and Window Cleaner Spray Bottle, Ammonia Free, Packaging Designed to Prevent Leakage and Breaking, Surface Cleaning Spray, Crystal Rain Scent, 23 Fl Oz	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:18:53.64442+00	2026-06-01 14:18:53.64442+00	\N	\N	\N	\N
3681a1d9-1cf8-4100-868e-d2b251e54994	8d2df498-b5c0-4f73-94cd-323956036113	Scotch Magic Tape, 3 Dispensered Rolls, Numerous Applications, Invisible, Clear Tape Engineered for Repairing, 3/4 x 300 Inches	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:18:56.488136+00	2026-06-01 14:18:56.488136+00	\N	\N	\N	\N
20cc4c48-d172-4fd2-b441-35a11ffeb4af	8d2df498-b5c0-4f73-94cd-323956036113	Anthony's Organic Fennel Seeds, 1.5 lb, Whole Seeds, Non-Irradiated, Gluten-Free, Non-GMO	\N	Food	1.00	bag	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:13:27.75749+00	2026-06-01 14:20:20.789524+00	\N	\N	\N	\N
5f47fe75-ad84-44ad-b480-e69e20c1abde	8d2df498-b5c0-4f73-94cd-323956036113	Active Element Commercial Dishwasher Rinse - Makes One 5-gallon pail - For High Temperature and Low Temp Dishwasher Machine - Commercial Strength	\N	Kitchen Supplies	1.00	bucket	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:13:53.757178+00	2026-06-01 14:30:24.564204+00	\N	\N	\N	\N
7d55e450-288a-4a19-90b0-70a30fedc198	8d2df498-b5c0-4f73-94cd-323956036113	BagDream Kraft Paper Bags 5.25x3.25x13 Inches 50Pcs Kraft Brown Paper Wine Bags with Handles Bulk for Wine, Gift, Retail, Party Favor	\N	Wine Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:49.974169+00	2026-06-01 14:31:08.61502+00	\N	\N	\N	\N
b95ac1db-4982-4d32-ba3c-fd342ac6f669	8d2df498-b5c0-4f73-94cd-323956036113	Topping Whipped Aerosol · SYSCO RELIANCE · [9814583] · 12/14 OZ	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:49.396387+00	2026-06-01 23:48:49.396387+00	\N	\N	\N	\N
47c5c273-26d7-4cf8-87eb-f3d426d32a3e	8d2df498-b5c0-4f73-94cd-323956036113	Amazon Basics Gentle & Mild Clear Liquid Hand Soap Refill, Triclosan-Free, Dermatologist-Tested, pH Balanced, Cruelty-Free, 50 Fluid Ounces, 1-Pack (Previously Solimo)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:18:59.505169+00	2026-06-01 14:18:59.505169+00	\N	\N	\N	\N
fb283e74-0bc1-47ff-a19f-95f0a73dcdb4	8d2df498-b5c0-4f73-94cd-323956036113	Rozer 200 Pcs Mini Appetizer Plates and Tear Drop Spoons for Weddings Party 2.5 x 2.5 Inches 4 x 2 Inches Plastic Mini Dessert Plates Disposable Appetizer Spoons (Transparent)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:19:06.288889+00	2026-06-01 14:19:06.288889+00	\N	\N	\N	\N
6b05c99e-aba4-4d18-be1a-1208ed861330	8d2df498-b5c0-4f73-94cd-323956036113	Amazon Basics Gentle & Mild Clear Liquid Hand Soap Refill, Triclosan-free, 50 Fluid Ounces, 1-Pack	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:21:51.845144+00	2026-06-01 14:21:51.845144+00	\N	\N	\N	\N
ea3ae886-d2c4-4358-8962-0f847f3e9a42	8d2df498-b5c0-4f73-94cd-323956036113	SAN FRANCISCO BAY Coffee French Roast Whole Bean 2LB (32 Ounce) Dark Roast	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:21:53.996993+00	2026-06-01 14:21:53.996993+00	\N	\N	\N	\N
1fee12b1-01da-4bfa-855b-660ece2a0ce2	8d2df498-b5c0-4f73-94cd-323956036113	Amazon Basics Tall Kitchen Drawst	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:28.996966+00	2026-06-01 14:23:28.996966+00	\N	\N	\N	\N
a0c8c8d9-ade6-4f37-9224-f431ed2b6be2	8d2df498-b5c0-4f73-94cd-323956036113	Lysol Toilet Bowl Cleaner Gel, For Cleaning and Disinfecting, Stain Removal, Forest Rain Scent, 24oz (Pack of 2)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:37.876563+00	2026-06-01 14:23:37.876563+00	\N	\N	\N	\N
01dbf247-453a-404b-a111-f84468c09d1f	8d2df498-b5c0-4f73-94cd-323956036113	2 Pack Heavy Mop Replace Headmop Head Replacement,Commercial mop Heads,Reusable Mop Head Refills-Replacement Mop Heads SuitableWet Industrial Blue Cotton Looped End String Head Refill (Blue)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:43.936199+00	2026-06-01 14:23:43.936199+00	\N	\N	\N	\N
a261b22b-ee7f-4547-ba01-f26b4f691c10	8d2df498-b5c0-4f73-94cd-323956036113	FORLIM Electric Salt and Pepper Grinder Set, USB Rechargeable, Automatic Salt Pepper Mill Grinder with Dust Cover, One-Button Control, Adjustable Coarseness, Warm LED Light (2 Packs, Black&White)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:45.660153+00	2026-06-01 14:23:45.660153+00	\N	\N	\N	\N
f3e6c7d2-8348-4f6a-bf67-eb574e817711	8d2df498-b5c0-4f73-94cd-323956036113	Ateco 4418 Plastic Disposable Piping and Cake Decorating Bags with NuPlastiQ, Pack of 100, Clear	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:48.656319+00	2026-06-01 14:23:48.656319+00	\N	\N	\N	\N
db07d174-f82b-4a4e-9429-bf3d1d9188f7	8d2df498-b5c0-4f73-94cd-323956036113	Amazon Basics 2-Ply Soft Toilet Paper, 30 Rolls (5 Packs of 6), Equivalent to 185 Regular Rolls, Packaging May Vary	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:51.796167+00	2026-06-01 14:23:51.796167+00	\N	\N	\N	\N
9ff1e848-efe6-4112-88db-d119d422cc4a	8d2df498-b5c0-4f73-94cd-323956036113	Industrial Paper Towels 10 x 800 White Roll Towels High Capacity Premium Quality (TAD Fabric Cloth Like Texture) Fits To Touchless Automatic Commercial Towel Dispenser (Packed 6 Rolls)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:57.673672+00	2026-06-01 14:23:57.673672+00	\N	\N	\N	\N
eee16295-fbd2-4bef-b1f0-5dee3f8e9a2a	8d2df498-b5c0-4f73-94cd-323956036113	Amazon Basics 2-Ply Flex-Sheets Paper Towels, 12 Basics Rolls = 40 Regular Rolls, Everyday Value with 150 Sheets per Roll, Packaging May Vary	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:11.061266+00	2026-06-01 14:24:11.061266+00	\N	\N	\N	\N
ac7c1db5-32b1-45c0-ba7c-65293de97209	8d2df498-b5c0-4f73-94cd-323956036113	Sabatino Tartufi Truffle Zest Seasoning, The Original All Purpose Gourmet Truffle Powder, Plant Based, Vegan and Vegetarian Friendly, Low Carb, 1.76 oz	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:27.56892+00	2026-06-01 14:24:27.56892+00	\N	\N	\N	\N
ca2d6056-28b8-4a1d-bc07-ecad76ce22c4	8d2df498-b5c0-4f73-94cd-323956036113	Leafiew 50 Pack Small Charcuterie Boxes with Clear Lids - To Go Paper Mini Charcuterie Box, Disposable Food Containers, 5Inch Dessert Boxes - Sandwich, Cookie, Sushi, Cake Slice, Strawberries (Brown)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:44.181373+00	2026-06-01 14:24:44.181373+00	\N	\N	\N	\N
9784f7e6-9cfc-4e9a-9e41-3ff4bd67ee0f	8d2df498-b5c0-4f73-94cd-323956036113	Active Element Dish Chlorine Concentrate - Food Contact Surfaces- Commercial Dishwasher - No Rinse - Food Service Kitchen - Multi-Use - Makes one 5-Gallon Pails (Diluted Further to 1,280 Gallons)	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:58.009139+00	2026-06-01 14:24:58.009139+00	\N	\N	\N	\N
3d4cb702-48e9-40b6-abeb-d67b5a6b829a	8d2df498-b5c0-4f73-94cd-323956036113	ACTIVE Espresso Machine Cleaning Tablets Descaling - 120 Tabs | Compatible with Breville Barista Express, Gaggia, Delong hi, Jura, Philips | Expresso Maker Backflush Oil Remover Solution Clean Tablet	\N	Kitchen Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:14.969303+00	2026-06-01 14:25:34.424857+00	\N	\N	\N	\N
b761391a-0371-4762-b0ea-9a475e6bd29b	8d2df498-b5c0-4f73-94cd-323956036113	Guardian Cashier Deposit Report Envelopes - Made in America with Gummed Flaps, Pack of 500 Cash Drop Envelopes - Cash Register for Small Businesses, Retailers & Restaurants - Brown Kraft Envelope	\N	Office Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:21.865241+00	2026-06-01 14:26:11.180946+00	\N	\N	\N	\N
cdf84773-8554-49fe-8207-fd518ce345c1	8d2df498-b5c0-4f73-94cd-323956036113	Cream Heavy 40% Ultra High Temperature · DARIGOLD FARMS · [8722712] · 6/.5 GAL	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:37.962395+00	2026-06-01 23:48:37.962395+00	\N	\N	\N	\N
1f29b1ba-24bb-450e-adc0-66227bb7792f	8d2df498-b5c0-4f73-94cd-323956036113	The Original Donut Shop Regular K	\N	AirBnB Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:03.70517+00	2026-06-01 15:19:38.135036+00	\N	\N	\N	\N
f1d0c2fb-549b-4b61-9d88-4c331868107a	8d2df498-b5c0-4f73-94cd-323956036113	Flour Pizza Neapolitan · GRAIN CRAFT (FLOUR) · [7140422] · 1/25 LB	\N	Food	8.00	Bags	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:41:37.170492+00	2026-06-01 23:42:42.273429+00	\N	\N	\N	\N
9f167fbe-0226-4644-b4f4-0040afa64fcc	8d2df498-b5c0-4f73-94cd-323956036113	100 Pink Heart Cocktail Beverage Napkins Disposable Paper Love Hearts Dessert Napkin for Valentine's Day Wedding Party Supplies Tableware Decor	\N	Kitchen Supplies - Special Events	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:23:42.060897+00	2026-06-01 15:21:59.105017+00	\N	\N	\N	\N
44c7a6c8-10e5-48d6-9636-7b38eaa39e6b	8d2df498-b5c0-4f73-94cd-323956036113	Sauce Marinara California · ANGELA MIA · [5211552] · 6/#10	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:01.277657+00	2026-06-01 23:48:01.277657+00	\N	\N	\N	\N
1a044cca-185e-41d3-a850-d2e73a35ea30	8d2df498-b5c0-4f73-94cd-323956036113	Cheese Mozzarella Fresh Cryovac Log · ARREZZIO IMPERIAL · [1552272] · 8/1 LB	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:02.608372+00	2026-06-01 23:48:02.608372+00	\N	\N	\N	\N
7b200f00-59a4-4cc9-b67a-7f2cbc2f7b2c	8d2df498-b5c0-4f73-94cd-323956036113	Cheese Fontina Whole Red Wax Usa · ARREZZIO IMPERIAL · [4069870] · 1/10#AVG	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:05.249582+00	2026-06-01 23:48:05.249582+00	\N	\N	\N	\N
6237df12-0455-4d53-b048-8ef1921f6489	8d2df498-b5c0-4f73-94cd-323956036113	Napkin Dinner 17 Inch X 17 Inch 1/8 Fold Finesse · SYSCO CLASSIC · [8195794] · 4/75 CT	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:06.791925+00	2026-06-01 23:48:06.791925+00	\N	\N	\N	\N
e5fb1f8f-e15d-4da0-9251-dc558fab48e3	8d2df498-b5c0-4f73-94cd-323956036113	Cheese Mozzarella Part Skim · GALBANI · [1913573] · 8/5# AVG	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:07.63848+00	2026-06-01 23:48:07.63848+00	\N	\N	\N	\N
7446ca06-b0cd-4e40-9a3c-59d597f8ce25	8d2df498-b5c0-4f73-94cd-323956036113	Box Pizza 8 Inch White-outside-kraft-inside B-flute 1.875 Inch · SYSCO CLASSIC · [3282322] · 50/8X8"	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:17.598402+00	2026-06-01 23:48:17.598402+00	\N	\N	\N	\N
596083bb-e38b-4060-8faf-40c2cdb0d5c3	8d2df498-b5c0-4f73-94cd-323956036113	Pepperoni Sliced Pork And Beef 14-16 Count · ARREZZIO IMPERIAL · [2544831] · 1/10LB	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:20.84843+00	2026-06-01 23:48:20.84843+00	\N	\N	\N	\N
5f2055c2-b32d-4456-824b-09e078b2a333	8d2df498-b5c0-4f73-94cd-323956036113	Ham Prosciutto Sliced · BUSSETO · [9602665] · 12/3 OZ	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:24.941798+00	2026-06-01 23:48:24.941798+00	\N	\N	\N	\N
2aec350f-f60b-4808-9b1f-2c5dc7372269	8d2df498-b5c0-4f73-94cd-323956036113	Box Pizza 12 Inch White/kraft B-flute 1.875 Inch · SYSCO CLASSIC · [0539510] · 50/1 EA	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:38.90241+00	2026-06-01 23:48:38.90241+00	\N	\N	\N	\N
e13809a9-2d7d-4877-a2e9-0e0180d852e6	8d2df498-b5c0-4f73-94cd-323956036113	Pepper Chipotle Adobo Sauce · EMBASA · [5757091] · 12/7 OZ	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:40.724187+00	2026-06-01 23:48:40.724187+00	\N	\N	\N	\N
af571182-a671-4d84-8f97-d7846a5eec13	8d2df498-b5c0-4f73-94cd-323956036113	Cup Plastic Clear Rpet Squat 9 Ounce · EARTH PLUS · [7473299] · 15/65CT	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:42.453886+00	2026-06-01 23:48:42.453886+00	\N	\N	\N	\N
c0eee796-131d-4a52-b155-53bc726e0579	8d2df498-b5c0-4f73-94cd-323956036113	Glove Nitrile Foodservice Powder Free Blue Sma · SYSCO CLASSIC · [2306746] · 10/100CT	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:43.001127+00	2026-06-01 23:48:43.001127+00	\N	\N	\N	\N
cfccfb65-e50e-4d7a-920c-ef43552ed480	8d2df498-b5c0-4f73-94cd-323956036113	100 Pack Essential Skewers Wood Pick Food Decorations Skewers Essential Tool Perfect For Cocktails And Outdoor Cooking Fruit Fork	\N	Kitchen Supplies	\N	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:24:41.600818+00	2026-06-02 05:56:18.525981+00	\N	\N	\N	\N
efcdcf07-68ad-4f38-aa81-8404265d982a	8d2df498-b5c0-4f73-94cd-323956036113	Box Pizza 12 Inch White/kraft B-flute 1.875 Inch · SYSCO CLASSIC · [0539510] · 50/12x12	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:53.378652+00	2026-06-01 23:48:53.378652+00	\N	\N	\N	\N
82d33dd4-15b9-435c-8b3b-edc87a14162b	8d2df498-b5c0-4f73-94cd-323956036113	Liner Trash Repro 38 Inch X 58 Inch 1.5 Reprocessed Lldpe-linear Low Density Polyethylene · SYSCO RELIANCE · [1763846] · 100/60GAL	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:54.707823+00	2026-06-01 23:48:54.707823+00	\N	\N	\N	\N
27493896-4e71-429e-b7cf-ddc3b262df2f	8d2df498-b5c0-4f73-94cd-323956036113	Cheese Mozzarella Whole Milk · GALBANI · [1864305] · 8/5#AVG	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:48:56.207588+00	2026-06-01 23:48:56.207588+00	\N	\N	\N	\N
bca07601-80b3-47c0-8e37-21a3d9fe2ab9	8d2df498-b5c0-4f73-94cd-323956036113	Napkin Dinner 17 X 17 1/8 Fold Finesse · SYSCO CLASSIC · [8195794] · 4/75 CT	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:49:34.154394+00	2026-06-01 23:49:34.154394+00	\N	\N	\N	\N
2430f6cc-5594-4801-b339-7bf312ffd9c9	8d2df498-b5c0-4f73-94cd-323956036113	Glove Nitrile Foodservice Powder-free Blue Small · SYSCO CLASSIC · [2306746] · 10/100CT	\N	\N	\N	box	f	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 23:49:41.652907+00	2026-06-01 23:49:41.652907+00	\N	\N	\N	\N
0272ba25-0b10-458f-8202-516b47b4579c	8d2df498-b5c0-4f73-94cd-323956036113	18 Pack Stainless Steel Scrubber, Steel Wool Scrubber for Scouring Stubborn Messes from Pots and Pans, Stoves, Broiler Racks, Grills and More	\N	Kitchen Supplies	1.00	box	t	\N	97b78fcd-73ef-49b9-9bd0-0f17fd918092	2026-06-01 14:11:05.216663+00	2026-06-02 05:55:56.964523+00	\N	\N	\N	\N
\.


--
-- Name: shopping_inventory_log shopping_inventory_log_pkey; Type: CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory_log
    ADD CONSTRAINT shopping_inventory_log_pkey PRIMARY KEY (id);


--
-- Name: shopping_inventory shopping_inventory_pkey; Type: CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory
    ADD CONSTRAINT shopping_inventory_pkey PRIMARY KEY (id);


--
-- Name: shopping_inventory shopping_inventory_shopping_item_id_location_id_key; Type: CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory
    ADD CONSTRAINT shopping_inventory_shopping_item_id_location_id_key UNIQUE (shopping_item_id, location_id);


--
-- Name: shopping_item_locations shopping_item_locations_pkey; Type: CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_locations
    ADD CONSTRAINT shopping_item_locations_pkey PRIMARY KEY (shopping_item_id, location_id);


--
-- Name: shopping_item_purchases shopping_item_purchases_pkey; Type: CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_purchases
    ADD CONSTRAINT shopping_item_purchases_pkey PRIMARY KEY (id);


--
-- Name: shopping_items shopping_items_pkey; Type: CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_items
    ADD CONSTRAINT shopping_items_pkey PRIMARY KEY (id);


--
-- Name: idx_shopping_inv_log_item; Type: INDEX; Schema: teamtask_hub; Owner: -
--

CREATE INDEX idx_shopping_inv_log_item ON teamtask_hub.shopping_inventory_log USING btree (shopping_item_id, counted_at DESC);


--
-- Name: idx_shopping_inventory_company; Type: INDEX; Schema: teamtask_hub; Owner: -
--

CREATE INDEX idx_shopping_inventory_company ON teamtask_hub.shopping_inventory USING btree (company_id, location_id);


--
-- Name: idx_shopping_item_locations_company; Type: INDEX; Schema: teamtask_hub; Owner: -
--

CREATE INDEX idx_shopping_item_locations_company ON teamtask_hub.shopping_item_locations USING btree (company_id, location_id);


--
-- Name: idx_shopping_items_company; Type: INDEX; Schema: teamtask_hub; Owner: -
--

CREATE INDEX idx_shopping_items_company ON teamtask_hub.shopping_items USING btree (company_id);


--
-- Name: idx_shopping_purchases_company; Type: INDEX; Schema: teamtask_hub; Owner: -
--

CREATE INDEX idx_shopping_purchases_company ON teamtask_hub.shopping_item_purchases USING btree (company_id);


--
-- Name: idx_shopping_purchases_item; Type: INDEX; Schema: teamtask_hub; Owner: -
--

CREATE INDEX idx_shopping_purchases_item ON teamtask_hub.shopping_item_purchases USING btree (shopping_item_id);


--
-- Name: shopping_inventory shopping_inventory_company_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory
    ADD CONSTRAINT shopping_inventory_company_id_fkey FOREIGN KEY (company_id) REFERENCES teamtask_hub.companies(id) ON DELETE CASCADE;


--
-- Name: shopping_inventory shopping_inventory_last_counted_by_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory
    ADD CONSTRAINT shopping_inventory_last_counted_by_fkey FOREIGN KEY (last_counted_by) REFERENCES teamtask_hub.users(id) ON DELETE SET NULL;


--
-- Name: shopping_inventory shopping_inventory_location_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory
    ADD CONSTRAINT shopping_inventory_location_id_fkey FOREIGN KEY (location_id) REFERENCES teamtask_hub.locations(id) ON DELETE CASCADE;


--
-- Name: shopping_inventory_log shopping_inventory_log_company_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory_log
    ADD CONSTRAINT shopping_inventory_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES teamtask_hub.companies(id) ON DELETE CASCADE;


--
-- Name: shopping_inventory_log shopping_inventory_log_counted_by_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory_log
    ADD CONSTRAINT shopping_inventory_log_counted_by_fkey FOREIGN KEY (counted_by) REFERENCES teamtask_hub.users(id) ON DELETE SET NULL;


--
-- Name: shopping_inventory_log shopping_inventory_log_location_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory_log
    ADD CONSTRAINT shopping_inventory_log_location_id_fkey FOREIGN KEY (location_id) REFERENCES teamtask_hub.locations(id) ON DELETE CASCADE;


--
-- Name: shopping_inventory_log shopping_inventory_log_shopping_item_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory_log
    ADD CONSTRAINT shopping_inventory_log_shopping_item_id_fkey FOREIGN KEY (shopping_item_id) REFERENCES teamtask_hub.shopping_items(id) ON DELETE CASCADE;


--
-- Name: shopping_inventory shopping_inventory_shopping_item_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_inventory
    ADD CONSTRAINT shopping_inventory_shopping_item_id_fkey FOREIGN KEY (shopping_item_id) REFERENCES teamtask_hub.shopping_items(id) ON DELETE CASCADE;


--
-- Name: shopping_item_locations shopping_item_locations_company_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_locations
    ADD CONSTRAINT shopping_item_locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES teamtask_hub.companies(id) ON DELETE CASCADE;


--
-- Name: shopping_item_locations shopping_item_locations_location_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_locations
    ADD CONSTRAINT shopping_item_locations_location_id_fkey FOREIGN KEY (location_id) REFERENCES teamtask_hub.locations(id) ON DELETE CASCADE;


--
-- Name: shopping_item_locations shopping_item_locations_shopping_item_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_locations
    ADD CONSTRAINT shopping_item_locations_shopping_item_id_fkey FOREIGN KEY (shopping_item_id) REFERENCES teamtask_hub.shopping_items(id) ON DELETE CASCADE;


--
-- Name: shopping_item_purchases shopping_item_purchases_company_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_purchases
    ADD CONSTRAINT shopping_item_purchases_company_id_fkey FOREIGN KEY (company_id) REFERENCES teamtask_hub.companies(id) ON DELETE CASCADE;


--
-- Name: shopping_item_purchases shopping_item_purchases_receipt_item_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_purchases
    ADD CONSTRAINT shopping_item_purchases_receipt_item_id_fkey FOREIGN KEY (receipt_item_id) REFERENCES teamtask_hub.receipt_items(id) ON DELETE SET NULL;


--
-- Name: shopping_item_purchases shopping_item_purchases_shopping_item_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_item_purchases
    ADD CONSTRAINT shopping_item_purchases_shopping_item_id_fkey FOREIGN KEY (shopping_item_id) REFERENCES teamtask_hub.shopping_items(id) ON DELETE CASCADE;


--
-- Name: shopping_items shopping_items_company_id_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_items
    ADD CONSTRAINT shopping_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES teamtask_hub.companies(id) ON DELETE CASCADE;


--
-- Name: shopping_items shopping_items_created_by_fkey; Type: FK CONSTRAINT; Schema: teamtask_hub; Owner: -
--

ALTER TABLE ONLY teamtask_hub.shopping_items
    ADD CONSTRAINT shopping_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES teamtask_hub.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


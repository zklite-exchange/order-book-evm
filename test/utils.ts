import hre from "hardhat";
import BN, {BigNumber} from "bignumber.js";
import chai, {assert, expect} from "chai";
import {DurationInputArg1, DurationInputArg2} from "moment";
import moment from "moment/moment";
import {ERC20, OrderBook} from "../typechain";
import {Addressable, AddressLike, BigNumberish, ethers, TransactionResponse} from "ethers";
import {Provider} from "zksync-ethers";
import {loadFixture, time} from "@nomicfoundation/hardhat-network-helpers";
import chaiBN from 'chai-bignumber';
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import RoundingMode = BigNumber.RoundingMode;
import {DeployProxyOptions, getInitializerData} from "@openzeppelin/hardhat-upgrades/dist/utils";
import {Manifest} from "@openzeppelin/upgrades-core";
import {OrderCloseReason, OrderSide, TimeInForce} from "../index";

BigNumber.config({EXPONENTIAL_AT: 1e+9});
chai.use(chaiBN());



async function deployContract<T extends ethers.BaseContract>(owner: any, contractName: string, args: any[] = []): Promise<T> {
    let contract: T;
    if (hre.network.zksync) {
        hre.deployer.setWallet(owner);

        contract = await hre.deployer.deploy(contractName, args) as any;
    } else {
        contract =  (await hre.ethers.deployContract(contractName, args, owner)) as any;
    }
    const gasUsed = (await contract.deploymentTransaction()?.wait())?.gasUsed;
    console.log(`Deploy ${contractName} cost ${gasUsed} gas`);
    return contract;
}

async function deployProxy<T extends ethers.BaseContract>(
    owner: any, contractName: string,
    opts?: DeployProxyOptions & {
        initArgs?: any[];
    }
): Promise<T> {
    if (hre.network.zksync) {
        // to verify whether contract is upgradable safe, just test with @openzeppelin/hardhat-upgrades instead
        const manifest = await Manifest.forNetwork(owner.provider);
        const impl = await deployContract<T>(owner, contractName, opts?.constructorArgs);
        const data = getInitializerData(impl.interface, opts?.initArgs ?? [], opts?.initializer);
        const proxy = await deployContract<T>(owner, "TransparentUpgradeableProxy", [await impl.getAddress(), owner.address, data]);
        await manifest.addProxy({
            kind: 'transparent',
            address: await proxy.getAddress(),
            txHash: proxy.deploymentTransaction()?.hash,
            ...{
                deployTransaction: proxy.deploymentTransaction(),
            },
            ...proxy.deploymentTransaction()
        });
        return impl.attach(await proxy.getAddress()) as any;
    } else {
        return (await hre.upgrades.deployProxy(await hre.ethers.getContractFactory(contractName), opts?.initArgs ?? [], {
            ...opts,
            initialOwner: owner
        })) as any;
    }
}

export async function deployFakeTokens(owner: any) {
    const WETH = await deployContract<ERC20>(owner, "WETH");
    const USDC = await deployContract<ERC20>(owner, "USDC");
    return {
        WETH, USDC
    };
}

export async function setUpTest() {
    if (hre.network.zksync) return _setUpTest();
    return loadFixture(_setUpTest);
}

type BNTypes = BigNumberish | BN.Value;

function toBN(value: BNTypes): BN {
    if (BN.isBigNumber(value)) return value as BN;
    return new BN(value.toString());
}

async function _setUpTest() {
    let [alice, bob, admin] = hre.network.zksync
        ? await hre.zksyncEthers.getWallets()
        : await hre.ethers.getSigners();

    if (hre.network.zksync) {
        const provider = new Provider((hre.network.config as any).url, undefined, {cacheTimeout: -1});
        alice = alice.connect(provider) as any;
        bob = bob.connect(provider) as any;
        admin = admin.connect(provider) as any;
    }

    const {WETH, USDC} = await deployFakeTokens(admin);
    const ethDecimalPow = `1e${Number(await WETH.decimals())}`;
    const usdcDecimalPow = `1e${Number(await USDC.decimals())}`;
    await WETH.transfer(bob.address, new BN(1000).times(ethDecimalPow).dp(0).toString());
    await WETH.transfer(alice.address, new BN(1000).times(ethDecimalPow).dp(0).toString());
    await USDC.transfer(bob.address, new BN(150000).times(usdcDecimalPow).dp(0).toString());
    await USDC.transfer(alice.address, new BN(150000).times(usdcDecimalPow).dp(0).toString());

    //deploy contract
    const takerFeeBps = 0.1 / 0.01; // 0.1% = 10 basis points
    const makerFeeBps = 0.1 / 0.01; // 0.1% = 10 basis points
    const priceDecimals = 20;
    const minExecuteQuote = new BN(5).times(usdcDecimalPow).toString(); // 5 USDC
    const minQuoteChargeFee = minExecuteQuote;
    const OrderBookContract = await deployProxy<OrderBook>(
        admin, "OrderBook", {
            initArgs: [admin.address],
            initializer: "initV1",
            constructorArgs: ["zkLite Order Book", "v1"]
        }
    );
    expect(await OrderBookContract.getAdmin()).eq(admin.address);
    const wethAddress = await WETH.getAddress();
    const usdcAddress = await USDC.getAddress();
    let defaultPairId = 0;
    await expect(
        OrderBookContract.connect(admin)
            .createPair(
                wethAddress, usdcAddress,
                priceDecimals, minExecuteQuote, minQuoteChargeFee, takerFeeBps, makerFeeBps
            )
    ).to.emit(OrderBookContract, "NewPairConfigEvent")
        .withArgs(
            wethAddress, usdcAddress, minExecuteQuote, minQuoteChargeFee,
            (id: bigint) => {
                defaultPairId = Number(id);
                return true;
            },
            takerFeeBps, makerFeeBps, priceDecimals, true
        );
    expect(defaultPairId).gt(0);

    const priceDecimalPow = `1e${priceDecimals}`;
    const uintMax = new BN('2').pow(256).minus(1).toString();
    return {
        alice, bob, admin, WETH, USDC, wethAddress, usdcAddress,
        OrderBookContract, defaultPairId,
        takerFeeBps, makerFeeBps, minExecuteQuote, minQuoteChargeFee,
        usdcDecimalPow, ethDecimalPow, priceDecimalPow, uintMax,
        fmtUsdc: (value: BNTypes) => toBN(value).times(usdcDecimalPow).dp(0).toString(),
        fmtWeth: (value: BNTypes) => toBN(value).times(ethDecimalPow).dp(0).toString(),
        fmtPrice: (price: BN.Value) => new BN(price).times(usdcDecimalPow).times(priceDecimalPow)
            .div(ethDecimalPow).dp(0).toString(),
        expireAfter: async (amount: DurationInputArg1, unit: DurationInputArg2) =>
            moment.unix(await currentBlockTime()).add(amount, unit).unix(),
        approveSpending: async (token: ERC20, owner: ethers.Signer, amount: BigNumberish | 'max') =>
            token.connect(owner).approve(await OrderBookContract.getAddress(), amount == 'max' ? uintMax : amount),

        mulPrice: (value: BNTypes, price: BNTypes, rounding?: RoundingMode) =>
            toBN(value).times(toBN(price)).div(priceDecimalPow).dp(0, rounding).toString(),
        divPrice: (value: BNTypes, price: BNTypes, rounding?: RoundingMode) =>
            toBN(value).times(priceDecimalPow).div(toBN(price)).dp(0, rounding).toString(),

        calcFee: (executeAmt: BigNumberish, feeBps: BigNumberish) =>
            new BN(executeAmt.toString()).times(feeBps.toString()).div(10000).dp(0, BN.ROUND_DOWN).toString(),
    };
}

export function getZkTestProvider(): Provider {
    return new Provider((hre.network.config as any).url);
}

export async function currentBlockTime(): Promise<number> {
    return hre.network.zksync
        ? getZkTestProvider().send("config_getCurrentTimestamp", [])
        : await time.latest();
}

export async function expectTokenChangeBalance(
    tx: TransactionResponse | Promise<TransactionResponse>,
    token: ERC20, accounts: AddressLike[], changes: BN.Value[]
) {
    if (hre.network.zksync) {
        const receipt = await (await tx).wait();
        assert(receipt != null);
        const actualChanges: any = {};
        const eventFragment = token.interface.getEvent("Transfer");
        const transferTopicHash = eventFragment.topicHash;
        for (let i = 0; i < receipt.logs.length; i++) {
            const log = receipt.logs[i];
            if (log.address == await token.getAddress() && log.topics[0] === transferTopicHash) {
                const transferEvent = token.interface.decodeEventLog(eventFragment, log.data, log.topics);
                const from = transferEvent.from;
                const to = transferEvent.to;
                const value = new BN(transferEvent.value);
                actualChanges[from] = (actualChanges[from] ?? new BN(0)).minus(value);
                actualChanges[to] = (actualChanges[to] ?? new BN(0)).plus(value);
            }
        }
        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            const address = typeof account == 'string'
                ? account
                : (account as Addressable).getAddress
                    ? await (account as Addressable).getAddress()
                    : await account;
            const change = actualChanges[address as string] ?? new BN(0);
            expect(change).eq(changes[i]);
        }
    } else {
        await expect(tx).changeTokenBalances(token, accounts, changes.map(it => it.toString()));
    }
}

type ActionUpdateAllowance = { from: ethers.Signer; token: ERC20; amount: 'max' | BigNumberish };
type ActionSubmitOrder = {
    alias?: string;
    owner?: ethers.Signer;
    pairId?: BigNumberish;
    side: OrderSide;
    price: BigNumberish;
    amount: BigNumberish;
    validUtil?: BigNumberish | Promise<BigNumberish>;
    tif?: TimeInForce;
    orderAliasesToFill?: string[];
    orderAliasesToCancel?: string[];
    expectReverted?: ExpectReverted;
    expectFills?: ExpectFill[];
    expectNoFill?: boolean;
    expectBalanceChange?: ExpectBalanceChange[];
    expectClosed?: ExpectCloseEvent[];
};

type ActionCancelOrder = {
    alias: string | string[];
    signer: ethers.Signer;
    expectReverted?: ExpectReverted;
    expectClosed?: ExpectCloseEvent[];
};

type ExpectReverted = {
    errorName?: string;
    message?: string;
};

type ExpectOrder = {
    alias: string;
    closed?: true;
    owner?: AddressLike;
    price?: BigNumberish;
    amount?: BigNumberish;
    unfilledAmt?: BigNumberish;
    receivedAmt?: BigNumberish;
    feeAmt?: BigNumberish;
    pairId?: BigNumberish;
    side?: OrderSide;
    validUntil?: BigNumberish | Promise<BigNumberish>;
    checkActiveOrderIds?: boolean;
};

type ExpectFill = {
    makerOrderAlias?: string;
    takerOrderAlias?: string;
    maker?: AddressLike;
    taker?: AddressLike;
    executedQuote?: BigNumberish;
    executedBase?: BigNumberish;
    feeTaker?: BigNumberish;
    feeMaker?: BigNumberish;
    pairId?: BigNumberish;
    takerSide?: OrderSide;
};

type ExpectCloseEvent = {
    alias?: string;
    owner?: AddressLike;
    receiveAmt?: BigNumberish;
    executeAmt?: BigNumberish;
    feeAmt?: BigNumberish;
    pairId?: BigNumberish;
    side?: OrderSide;
    reason?: OrderCloseReason;
};

type ExpectBalanceChange = {
    token: ERC20; accounts: AddressLike[]; changes: BN.Value[];
};

export type TestScenarios = {
    updateAllowance?: ActionUpdateAllowance | ActionUpdateAllowance[];
    submitOrder?: ActionSubmitOrder;
    cancelOrder?: ActionCancelOrder;
    expectOrder?: ExpectOrder | ExpectOrder[];
    run?: () => Promise<void>;
};

type TestSetUpData = Awaited<ReturnType<typeof setUpTest>> & {
    OrderBookContract: OrderBook;
};

export async function executeTestScenarios(load: TestSetUpData, scenarios: TestScenarios[]) {
    const orderAlias2Id: any = {};
    const getOrderIdByAlias = (alias: string): BigNumberish => {
        const id = orderAlias2Id[alias];
        expect(id, `Order alias "${alias}" not found`).gt(0);
        return id;
    };
    const wrapArray = <T>(value: T | T[]): T[] => {
        return Array.isArray(value) ? value : [value];
    };

    for (let i = 0; i < scenarios.length; i++) {
        const step = scenarios[i];
        if (step.run) {
            await step.run();
        } else if (step.updateAllowance) {
            const updates = wrapArray(step.updateAllowance);
            for (let j = 0; j < updates.length; j++) {
                await load.approveSpending(updates[j].token, updates[j].from, updates[j].amount);
            }
        } else if (step.submitOrder) {
            const orderOwner = step.submitOrder.owner ?? load.alice;
            const pairId = step.submitOrder.pairId ?? load.defaultPairId;
            const tif = step.submitOrder.tif ?? TimeInForce.GTC;
            const _validUtil = step.submitOrder.validUtil
                ? await (step.submitOrder.validUtil)
                : moment.unix(await currentBlockTime()).add(1, 'day').unix();
            const tx = (load.OrderBookContract).connect(orderOwner)
                .submitOrder(
                    step.submitOrder.side,
                    step.submitOrder.price,
                    step.submitOrder.amount, pairId,
                    _validUtil,
                    tif,
                    step.submitOrder.orderAliasesToCancel?.map(getOrderIdByAlias) ?? [],
                    step.submitOrder.orderAliasesToFill?.map(getOrderIdByAlias) ?? []
                );

            if (step.submitOrder.expectReverted) {
                expect(!!step.submitOrder.expectFills?.length).false;
                expect(!!step.submitOrder.expectBalanceChange?.length).false;
                expect(!!step.submitOrder.expectClosed?.length).false;

                await expectReverted(step.submitOrder.expectReverted, load.OrderBookContract, tx);
            } else {
                let orderId = 0n;
                const alias = step.submitOrder.alias ?? `step_${i}`;
                await expect(tx).to.emit(load.OrderBookContract, "NewOrderEvent")
                    .withArgs(
                        (_orderId: bigint) => {
                            orderId = _orderId;
                            return true;
                        },
                        orderOwner, step.submitOrder.price, step.submitOrder.amount, pairId,
                        step.submitOrder.side, _validUtil
                    );
                expect(orderId).gt(0);
                expect(orderAlias2Id[alias] == null).true;
                orderAlias2Id[alias] = orderId;

                const {expectFills, expectNoFill, expectBalanceChange, expectClosed} = step.submitOrder;
                if (expectNoFill) {
                    expect(!!expectFills?.length).false;
                    await expect(tx).to.not.emit(load.OrderBookContract, "FillEvent");
                } else if (expectFills) {
                    const promises = expectFills.map(expectFill =>
                        expect(tx).to.emit(load.OrderBookContract, "FillEvent")
                            .withArgs(
                                expectFill.makerOrderAlias ? getOrderIdByAlias(expectFill.makerOrderAlias) : anyValue,
                                expectFill.takerOrderAlias ? getOrderIdByAlias(expectFill.takerOrderAlias) : anyValue,
                                expectFill.maker ?? anyValue,
                                expectFill.taker ?? anyValue,
                                expectFill.executedQuote ?? anyValue,
                                expectFill.executedBase ?? anyValue,
                                expectFill.feeTaker ?? anyValue,
                                expectFill.feeMaker ?? anyValue,
                                expectFill.pairId ?? anyValue,
                                expectFill.takerSide ?? anyValue,
                            )
                    );
                    await Promise.all(promises);
                }

                if (expectBalanceChange) {
                    await Promise.all(
                        expectBalanceChange.map(it =>
                            expectTokenChangeBalance(tx, it.token, it.accounts, it.changes)));
                }
                if (expectClosed) {
                    await expectClosedEvent(expectClosed, load.OrderBookContract, tx, getOrderIdByAlias);
                }
            }
        } else if (step.cancelOrder) {
            const ids = wrapArray(step.cancelOrder.alias).map(getOrderIdByAlias);
            const tx = (load.OrderBookContract).connect(step.cancelOrder.signer)
                .cancelOrder(ids);
            if (step.cancelOrder.expectReverted) {
                expect(!!step.cancelOrder.expectClosed?.length).false;
                await expectReverted(step.cancelOrder.expectReverted, load.OrderBookContract, tx);
            } else if (step.cancelOrder.expectClosed) {
                await expectClosedEvent(step.cancelOrder.expectClosed, load.OrderBookContract, tx, getOrderIdByAlias);
            } else {
                await expect(tx).to.not.reverted;
            }
        } else if (step.expectOrder) {
            const expectOrders = wrapArray(step.expectOrder);
            for (let j = 0; j < expectOrders.length; j++) {
                await expectOrder(
                    load,
                    await load.OrderBookContract.getOrder(getOrderIdByAlias(expectOrders[j].alias)),
                    expectOrders[j],
                );
            }
        }
    }
}

const checkOptional = (value: any, _expect?: any, message?: string) => {
    if (_expect != null) expect(value, message).eq(_expect);
};

async function expectOrder(load: TestSetUpData, order: OrderBook.OrderStructOutput, params: ExpectOrder) {
    if (params.closed) {
        expect(order.id).eq(0);
        expect(order.price).eq(0);
        expect(order.amount).eq(0);
        return;
    }
    expect(order.id).gt(0);
    checkOptional(order.owner, params.owner, `order[${order.id}].owner`);
    checkOptional(order.price, params.price, `order[${order.id}].price`);
    checkOptional(order.amount, params.amount, `order[${order.id}].amount`);
    checkOptional(order.unfilledAmt, params.unfilledAmt, `order[${order.id}].unfilledAmount`);
    checkOptional(order.receivedAmt, params.receivedAmt, `order[${order.id}].receivedAmount`);
    checkOptional(order.feeAmt, params.feeAmt, `order[${order.id}].feeAmt`);
    checkOptional(order.pairId, params.pairId, `order[${order.id}].pairId`);
    checkOptional(order.side, params.side, `order[${order.id}].side`);
    checkOptional(order.validUntil, params.validUntil ? await params.validUntil : undefined, `order[${order.id}].validUtil`);
    if (params.checkActiveOrderIds) {
        expect(await load.OrderBookContract.getActiveOrderIds()).contain(order.id);
        expect(await (load.OrderBookContract as OrderBook).getActiveOrderIdsOf(order.owner)).contain(order.id);
    }
}

async function expectReverted(params: ExpectReverted, contract: { interface: any }, tx: Promise<TransactionResponse>) {
    if (params.message) {
        await expect(tx).to.be.revertedWith(params.message);
    } else if (params.errorName) {
        await expect(tx).to.be.revertedWithCustomError(contract, params.errorName);
    } else {
        await expect(tx).to.be.reverted;
    }
}

async function expectClosedEvent(
    param: ExpectCloseEvent[],
    contract: OrderBook,
    tx: Promise<TransactionResponse>,
    getOrderIdByAlias: (alias: string) => BigNumberish,
) {
    await Promise.all(param.map(it =>
        expect(tx).to.emit(contract, "OrderClosedEvent")
            .withArgs(
                it.alias ? getOrderIdByAlias(it.alias) : anyValue,
                it.owner ?? anyValue,
                it.receiveAmt ?? anyValue,
                it.executeAmt ?? anyValue,
                it.feeAmt ?? anyValue,
                it.pairId ?? anyValue,
                it.side ?? anyValue,
                it.reason ?? anyValue,
            )
    ));
}

type TestMatrix = {
    maker: ethers.Signer;
    taker: ethers.Signer;
    makerSide: OrderSide;
    takerSide: OrderSide;
    makerSellToken: ERC20;
    takerSellToken: ERC20;
    makerBuyToken: ERC20;
    takerBuyToken: ERC20;
    makerBalance: BN;
    takerBalance: BN;
};

export function orderMatrix(name: string, fn: (load: TestSetUpData, matrix: TestMatrix) => Promise<void>) {
    [OrderSide.BUY, OrderSide.SELL].forEach(function (makerSide) {
        it(`${makerSide} - ${name}`, async () => {
            const load = await setUpTest();
            const makerSellToken = makerSide == OrderSide.BUY ? load.USDC : load.WETH;
            const takerSellToken = makerSide == OrderSide.BUY ? load.WETH : load.USDC;
            await fn(load, {
                maker: load.bob,
                taker: load.alice,
                makerSide: makerSide,
                takerSide: makerSide == OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY,
                makerSellToken: makerSellToken,
                takerSellToken: takerSellToken,
                makerBuyToken: takerSellToken,
                takerBuyToken: makerSellToken,
                makerBalance: new BN((await makerSellToken.balanceOf(load.bob)).toString()),
                takerBalance: new BN((await takerSellToken.balanceOf(load.alice)).toString()),
            });
        });
    });
}

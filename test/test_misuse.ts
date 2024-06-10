import {executeTestScenarios, orderMatrix, OrderSide, setUpTest, TimeInForce} from "./utils";
import {expect} from "chai";
import {BigNumberish} from "ethers";
import BN from "bignumber.js";


describe("OrderBook - Blackbox testing misuse cases", async function () {
    it("Test invalid price/amount/pairId should revert", async () => {
        const load = await setUpTest();

        let inactivePairId: BigNumberish = -1;
        await expect(load.OrderBookContract.connect(load.admin)
            .createPair(load.USDC, load.WETH, 20, 0, 0, 0, 0))
            .to.emit(load.OrderBookContract, "NewPairConfigEvent")
            .withArgs(
                load.USDC, load.WETH, 0, 0,
                (id: bigint) => {
                    inactivePairId = id;
                    return true;
                },
                0, 0, 20, true
            );

        await load.OrderBookContract.connect(load.admin)
            .setPairActive(inactivePairId, false);

        await executeTestScenarios(load, [{
            updateAllowance: [
                {token: load.USDC, from: load.alice, amount: 'max'},
                {token: load.WETH, from: load.alice, amount: 'max'},
            ]
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtUsdc(10), side: OrderSide.BUY,
                price: 0,
                expectReverted: {message: "Invalid price"}
            }
        }, {
            submitOrder: {
                owner: load.alice, price: load.fmtPrice(10), side: OrderSide.BUY,
                amount: 0,
                expectReverted: {message: "Invalid amount"}
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtUsdc(10), side: OrderSide.BUY,
                price: load.fmtPrice(1), pairId: 99,
                expectReverted: {message: "Invalid pairId"}
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtUsdc(10), side: OrderSide.BUY,
                price: load.fmtPrice(1), pairId: inactivePairId,
                expectReverted: {message: "Pair isn't active"}
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: new BN(load.minExecuteQuote).minus(1).toString(), side: OrderSide.BUY,
                price: load.fmtPrice(1),
                expectReverted: {message: "Amount too small"}
            }
        }, {
            submitOrder: {
                owner: load.alice,
                amount: new BN(load.divPrice(load.minExecuteQuote, load.fmtPrice(1))).minus(1).toString(),
                side: OrderSide.SELL,
                price: load.fmtPrice(1),
                expectReverted: {message: "Amount too small"}
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtUsdc(20), side: OrderSide.BUY, price: load.fmtPrice(1),
                tif: TimeInForce.FOK,
                expectReverted: {
                    errorName: "NotFilled"
                }
            }
        },]);
    });

    it("Test tryFillOrder failure", async () => {
        const load = await setUpTest();

        let pair2: BigNumberish = -1;
        await expect(load.OrderBookContract.connect(load.admin)
            .createPair(load.WETH, load.USDC, 30, 0, 0, 0, 0))
            .to.emit(load.OrderBookContract, "NewPairConfigEvent")
            .withArgs(
                load.WETH, load.USDC, 0, 0,
                (id: bigint) => {
                    pair2 = id;
                    return true;
                },
                0, 0, 30, true
            );

        expect(pair2).gt(0);

        await executeTestScenarios(load, [{
            updateAllowance: [
                {token: load.USDC, from: load.alice, amount: 'max'},
                {token: load.USDC, from: load.bob, amount: 'max'},
                {token: load.WETH, from: load.alice, amount: 'max'},
                {token: load.WETH, from: load.bob, amount: 'max'},
            ]
        }, {
            submitOrder: {
                alias: 'pair2',
                owner: load.bob, amount: load.fmtUsdc(20), side: OrderSide.BUY, price: load.fmtPrice(1),
                pairId: pair2,
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtWeth(20), side: OrderSide.SELL, price: load.fmtPrice(1),
                pairId: load.defaultPairId, orderAliasesToFill: ['pair2'],
                expectNoFill: true, // pairIds are different
            }
        }, {
            submitOrder: {
                alias: 'maker1',
                owner: load.bob, amount: load.fmtUsdc(20), side: OrderSide.BUY, price: load.fmtPrice(1),
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtUsdc(20), side: OrderSide.BUY, price: load.fmtPrice(1),
                orderAliasesToFill: ['maker1'],
                expectNoFill: true, // same side BUY
            }
        }, {
            submitOrder: {
                owner: load.bob, amount: load.fmtWeth(20), side: OrderSide.SELL, price: load.fmtPrice(1),
                orderAliasesToFill: ['maker1'],
                expectNoFill: true, // same owner = bob
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtUsdc(20), side: OrderSide.BUY, price: load.fmtPrice(1),
                tif: TimeInForce.FOK,
                expectReverted: {
                    errorName: "NotFilled"
                }
            }
        }, {
            cancelOrder: {
                signer: load.bob, alias: 'maker1'
            }
        }, {
            submitOrder: {
                owner: load.alice, amount: load.fmtWeth(20), side: OrderSide.SELL, price: load.fmtPrice(1),
                orderAliasesToFill: ['maker1'],
                expectNoFill: true, // maker1 is cancelled
            }
        }]);
    });

    orderMatrix("Test tryFillOrder with bad price", async (load, m) => {
        const makerAmount = m.makerSide == OrderSide.BUY ? load.fmtUsdc(20) : load.fmtWeth(20);
        const takerAmount = m.makerSide == OrderSide.BUY ? load.fmtWeth(20) : load.fmtUsdc(20);
        const makerPrice = load.fmtPrice(10 + Math.random() * 10);
        // bad price is when buy price < sell price
        const badTakerPrice = m.makerSide == OrderSide.BUY
            ? new BN(makerPrice).plus(1).toString()
            : new BN(makerPrice).minus(1).toString();
        await executeTestScenarios(load, [{
            updateAllowance: [
                {token: m.makerSellToken, from: m.maker, amount: 'max'},
                {token: m.takerSellToken, from: m.taker, amount: 'max'},
            ]
        }, {
            submitOrder: {
                alias: 'maker1', owner: m.maker, amount: makerAmount, price: makerPrice, side: m.makerSide
            }
        }, {
            submitOrder: {
                owner: m.taker, amount: takerAmount, price: badTakerPrice, side: m.takerSide,
                orderAliasesToFill: ['maker1'],
                expectNoFill: true
            }
        }]);
    });
});


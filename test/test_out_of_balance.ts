import {executeTestScenarios, setUpTest} from "./utils";
import {OrderCloseReason, OrderSide} from "../index";

describe("OrderBook - Blackbox testing balance/allowance", async () => {
    it("Submit order amount greater than balance/allowance should fail", async () => {
        const load = await setUpTest();
        const bobEthBalance = await load.WETH.balanceOf(load.bob);
        const bobUsdcBalance = await load.USDC.balanceOf(load.bob);

        await executeTestScenarios(load, [{
            submitOrder: {
                owner: load.bob, side: OrderSide.BUY, amount: bobUsdcBalance + 1n, price: load.fmtPrice(1),
                expectReverted: {
                    message: "Not enough balance"
                }
            }
        }, {
            submitOrder: {
                owner: load.bob, side: OrderSide.BUY, amount: bobUsdcBalance, price: load.fmtPrice(1),
                expectReverted: {
                    message: "Exceed allowance"
                }
            }
        }, {
            submitOrder: {
                owner: load.bob, side: OrderSide.SELL, amount: bobEthBalance + 1n, price: load.fmtPrice(1),
                expectReverted: {
                    message: "Not enough balance"
                }
            }
        }, {
            submitOrder: {
                owner: load.bob, side: OrderSide.SELL, amount: bobEthBalance, price: load.fmtPrice(1),
                expectReverted: {
                    message: "Exceed allowance"
                }
            }
        }]);
    });

    it("After order submitted, balance/allowance change < unfilledAmount  -> should be closed while trying to fill", async () => {
        const load = await setUpTest();
        const maker = load.bob;
        const taker = load.alice;
        for (let makerSide = OrderSide.BUY; makerSide <= OrderSide.SELL; makerSide++) {
            const makerSellToken = makerSide == OrderSide.BUY ? load.USDC : load.WETH;
            const makerBuyToken = makerSide == OrderSide.BUY ? load.WETH : load.USDC;
            const takerSide = makerSide == OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
            const price = load.fmtPrice(1);
            await executeTestScenarios(load, [{
                updateAllowance: [
                    {from: maker, token: makerSellToken, amount: 'max'},
                    {from: taker, token: makerBuyToken, amount: 'max'},
                ],
            }, {
                submitOrder: {
                    alias: 'makerOrder1', owner: maker, side: makerSide, price,
                    amount: await makerSellToken.balanceOf(maker)
                }
            }, {
                updateAllowance: {
                    // reset allowance
                    from: maker, token: makerSellToken, amount: 0
                }
            }, {
                submitOrder: {
                    alias: 'takerOrder1', owner: taker, side: takerSide, price,
                    amount: await makerBuyToken.balanceOf(taker), orderAliasesToFill: ['makerOrder1'],
                    expectNoFill: true,
                    expectClosed: [{
                        alias: 'makerOrder1', reason: OrderCloseReason.OUT_OF_ALLOWANCE,
                        executeAmt: 0, receiveAmt: 0, feeAmt: 0
                    }]
                }
            }, {
                updateAllowance: {
                    from: maker, token: makerSellToken, amount: 'max'
                }

                // Test again, but now try to reduce balance after order submitted
            }, {
                submitOrder: {
                    alias: 'makerOrder2', owner: maker, side: makerSide, price,
                    amount: await makerSellToken.balanceOf(maker)
                }
            }, {
                run: async () => {
                    await makerSellToken.connect(maker).transfer(taker, 1n);
                }
            }, {
                submitOrder: {
                    owner: taker, side: takerSide, price, orderAliasesToCancel: ['takerOrder1'],
                    amount: await makerBuyToken.balanceOf(taker), orderAliasesToFill: ['makerOrder2'],
                    expectNoFill: true,
                    expectClosed: [{
                        alias: 'makerOrder2', reason: OrderCloseReason.OUT_OF_BALANCE,
                        executeAmt: 0, receiveAmt: 0, feeAmt: 0
                    }, {
                        alias: 'takerOrder1', reason: OrderCloseReason.CANCELLED
                    }]
                }
            }, {
                expectOrder: [
                    {alias: 'makerOrder1', closed: true},
                    {alias: 'makerOrder2', closed: true}
                ]
            }]);
        }
    });
});

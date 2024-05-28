import {loadFixture} from "@nomicfoundation/hardhat-network-helpers";
import {OrderCloseReason, OrderSide, setUpTest, submitOrderHelper} from "./utils";
import {expect} from "chai";
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";

describe("Blackbox testing OrderBook contract", async () => {
    it("Submit order amount greater than balance/allowance should fail", async () => {
        const load = await loadFixture(setUpTest);
        const bobEthBalance = await load.WETH.balanceOf(load.bob);
        const bobUsdcBalance = await load.USDC.balanceOf(load.bob);

        await expect(
            load.OrderBookContract.connect(load.bob).submitOrder(
                OrderSide.BUY, load.fmtPrice(3000), bobUsdcBalance + 1n, load.expireAfter(1, 'day'), []
            )
        ).to.be.revertedWith("Not enough balance");

        await expect(
            load.OrderBookContract.connect(load.bob).submitOrder(
                OrderSide.SELL, load.fmtPrice(3000), bobEthBalance + 1n, load.expireAfter(1, 'day'), []
            )
        ).to.be.revertedWith("Not enough balance");


        await expect(
            load.OrderBookContract.connect(load.bob).submitOrder(
                OrderSide.BUY, load.fmtPrice(3000), bobUsdcBalance, load.expireAfter(1, 'day'), []
            )
        ).to.be.revertedWith("Exceed quote allowance");

        await expect(
            load.OrderBookContract.connect(load.bob).submitOrder(
                OrderSide.SELL, load.fmtPrice(3000), bobEthBalance, load.expireAfter(1, 'day'), []
            )
        ).to.be.revertedWith("Exceed base allowance");
    });


    it("Balance/allowance change after order submitted -> should be closed while trying to fill", async () => {
        const load = await loadFixture(setUpTest);

        const maker = load.bob;
        for (let makerSide = OrderSide.BUY; makerSide <= OrderSide.SELL; makerSide++) {
            const makerSellToken = makerSide == OrderSide.BUY ? load.USDC : load.WETH;
            const makerBuyToken = makerSide == OrderSide.BUY ? load.WETH : load.USDC;
            const price = load.fmtPrice(3000);
            const makerSubmit = async () => {
                const makerBalance = await makerSellToken.balanceOf(maker.address);
                await makerSellToken.connect(maker).approve(await load.OrderBookContract.getAddress(), makerBalance);
                return await submitOrderHelper(load.OrderBookContract, maker, makerSide, price, makerBalance);
            };


            let makerOrderId = await makerSubmit();
            // test reset allowance
            await makerSellToken.connect(maker).approve(await load.OrderBookContract.getAddress(), 0);

            const takerSide = makerSide == OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
            await makerBuyToken.connect(load.alice)
                .approve(await load.OrderBookContract.getAddress(), await makerBuyToken.balanceOf(load.alice.address));
            const takerOrderId = await submitOrderHelper(
                load.OrderBookContract, load.alice, takerSide,
                price, await makerBuyToken.balanceOf(load.alice),
                undefined, [makerOrderId], async (tx) => {
                    await expect(tx).to.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(makerOrderId, maker.address, 0, 0, 0, anyValue, OrderCloseReason.OUT_OF_ALLOWANCE);
                });

            await load.OrderBookContract.connect(load.alice).cancelOrder(takerOrderId);


            makerOrderId = await makerSubmit();
            // test not enough balance
            await makerSellToken.connect(maker)
                .transfer(await load.OrderBookContract.getAddress(), await makerSellToken.balanceOf(maker.address));

            await submitOrderHelper(
                load.OrderBookContract, load.alice, takerSide,
                price, await makerBuyToken.balanceOf(load.alice),
                undefined, [makerOrderId], async (tx) => {
                    await expect(tx).to.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(makerOrderId, maker.address, 0, 0, 0, anyValue, OrderCloseReason.OUT_OF_BALANCE);
                });
        }
    });
});